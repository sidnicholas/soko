import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { sha256Hex, canonicalJson } from "@opportunity-os/audit";
import { assertTransition, SETTLEMENT_TRANSITIONS, TRANSACTION_TRANSITIONS } from "@opportunity-os/domain";
import type { EscrowCondition, EvidenceClaim, SettlementStatus, TransactionStatus } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";
import type { Database } from "../schema";

type Tx = Transaction<Database>;

async function planRow(tx: Tx, planId: string) {
  return tx.selectFrom("settlement_plans").selectAll().where("id", "=", planId).executeTakeFirstOrThrow();
}

/** One legal settlement-plan hop, guarded by the domain state machine (§20). */
async function stepPlan(tx: Tx, planId: string, from: SettlementStatus, to: SettlementStatus): Promise<void> {
  assertTransition("settlement", SETTLEMENT_TRANSITIONS, from, to);
  await tx.updateTable("settlement_plans").set({ status: to }).where("id", "=", planId).where("status", "=", from).execute();
}

export async function getSettlementPlan(id: string) {
  return getDb().selectFrom("settlement_plans").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getSettlementPlanByTransaction(transactionId: string) {
  return getDb()
    .selectFrom("settlement_plans")
    .selectAll()
    .where("transaction_id", "=", transactionId)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

export async function setSettlementPlanProviderRef(planId: string, providerRef: string): Promise<void> {
  await getDb().updateTable("settlement_plans").set({ provider_ref: providerRef }).where("id", "=", planId).execute();
}

export async function listMilestones(planId: string) {
  return getDb()
    .selectFrom("settlement_milestones")
    .selectAll()
    .where("settlement_plan_id", "=", planId)
    .orderBy("sequence", "asc")
    .execute();
}

export async function getMilestone(id: string) {
  return getDb().selectFrom("settlement_milestones").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface AddMilestoneInput {
  settlementPlanId: string;
  sequence: number;
  name: string;
  amount: { kind: "amount" | "percentage"; value: number };
  requiredEvidence?: unknown[];
  /** The release-condition tree evaluated by the escrow engine. */
  releaseConditions: EscrowCondition;
}

export async function addMilestone(input: AddMilestoneInput): Promise<{ id: string }> {
  const row = await getDb()
    .insertInto("settlement_milestones")
    .values({
      settlement_plan_id: input.settlementPlanId,
      sequence: input.sequence,
      name: input.name,
      amount_or_percentage: JSON.stringify(input.amount),
      required_evidence_json: JSON.stringify(input.requiredEvidence ?? []),
      release_conditions_json: JSON.stringify(input.releaseConditions),
      status: "pending",
      approved_at: null,
      released_at: null,
      external_transaction_ref: null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

/** Move a DRAFT plan through the funding sub-states to FUNDED (§20). */
export async function fundSettlementPlan(planId: string, actorId: string): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const plan = await planRow(tx, planId);
      await stepPlan(tx, planId, plan.status as SettlementStatus, "AWAITING_FUNDING_APPROVAL");
      await enqueueEvent(tx, {
        eventName: "settlement.funding_required.v1",
        aggregateType: "settlement_plan",
        aggregateId: planId,
        idempotencyKey: `settlement.funding_required:${planId}`,
        payload: { settlementPlanId: planId, totalAmount: plan.total_amount },
      });
      await stepPlan(tx, planId, "AWAITING_FUNDING_APPROVAL", "FUNDING_PENDING");
      await stepPlan(tx, planId, "FUNDING_PENDING", "FUNDED");
      await appendAuditEvent(tx, {
        actorType: "operator",
        actorId,
        action: "settlement.funded",
        entityType: "settlement_plan",
        entityId: planId,
      });
    });
}

export interface AppendEvidenceInput {
  entityType: string;
  entityId: string;
  claim: EvidenceClaim;
  /** Structured description of what the claim satisfies (predicate summary). */
  satisfies?: Record<string, unknown>;
}

/**
 * Append one row to the hash-chained evidence ledger (§21). Serialized per
 * entity by an advisory lock so the chain head cannot race; each row links to
 * the prior evidence_hash for the same (entity_type, entity_id).
 */
export async function appendEvidence(input: AppendEvidenceInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`${input.entityType}:${input.entityId}`}))`.execute(tx);
      const head = await tx
        .selectFrom("evidence")
        .select("evidence_hash")
        .where("entity_type", "=", input.entityType)
        .where("entity_id", "=", input.entityId)
        .orderBy("captured_at", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst();
      const previousHash = head?.evidence_hash ?? null;

      const id = randomUUID();
      const satisfies = input.satisfies ?? {};
      const core = {
        id,
        entity_type: input.entityType,
        entity_id: input.entityId,
        verifier: input.claim.verifier,
        trust_tier: input.claim.trustTier,
        predicate_type: input.claim.predicateType,
        content_hash: input.claim.contentHash,
        source_uri: input.claim.sourceUri,
        satisfies,
        captured_at: input.claim.capturedAt,
      };
      const evidenceHash = sha256Hex((previousHash ?? "") + canonicalJson(core));

      return tx
        .insertInto("evidence")
        .values({
          id,
          entity_type: input.entityType,
          entity_id: input.entityId,
          source: input.claim.verifier,
          source_uri: input.claim.sourceUri,
          content_hash: input.claim.contentHash,
          captured_at: input.claim.capturedAt,
          expires_at: null,
          metadata_json: JSON.stringify(input.claim.payload),
          verifier: input.claim.verifier,
          trust_tier: input.claim.trustTier,
          predicate_type: input.claim.predicateType,
          satisfies_json: JSON.stringify(satisfies),
          previous_evidence_hash: previousHash,
          evidence_hash: evidenceHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
}

/** Ledger rows for an entity, oldest first (audit/verifyChain input). */
export async function listEvidenceLedger(entityType: string, entityId: string) {
  return getDb()
    .selectFrom("evidence")
    .selectAll()
    .where("entity_type", "=", entityType)
    .where("entity_id", "=", entityId)
    .orderBy("captured_at", "asc")
    .orderBy("id", "asc")
    .execute();
}

/** Verified evidence claims for the escrow evaluator. */
export async function listEvidenceClaims(entityType: string, entityId: string): Promise<EvidenceClaim[]> {
  const rows = await listEvidenceLedger(entityType, entityId);
  return rows
    .filter((r) => r.verifier != null && r.trust_tier != null && r.predicate_type != null)
    .map((r) => ({
      verifier: r.verifier!,
      trustTier: r.trust_tier as EvidenceClaim["trustTier"],
      predicateType: r.predicate_type as EvidenceClaim["predicateType"],
      payload: (r.metadata_json ?? {}) as Record<string, unknown>,
      contentHash: r.content_hash,
      sourceUri: r.source_uri,
      capturedAt: new Date(r.captured_at as unknown as string).toISOString(),
    }));
}

/** Recompute the evidence ledger's hash chain and detect tampering (§21). */
export function verifyEvidenceChain(
  rows: readonly { previous_evidence_hash: string | null; evidence_hash: string | null }[],
): { ok: boolean; brokenAt?: number } {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if ((row.previous_evidence_hash ?? null) !== prev) return { ok: false, brokenAt: i };
    prev = row.evidence_hash ?? null;
  }
  return { ok: true };
}

/** Flip a milestone (and its plan) to verified after the engine confirms conditions (§20). */
export async function verifyMilestone(milestoneId: string, actorId: string): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const milestone = await tx
        .selectFrom("settlement_milestones")
        .selectAll()
        .where("id", "=", milestoneId)
        .executeTakeFirstOrThrow();
      const plan = await planRow(tx, milestone.settlement_plan_id);
      const planStatus = plan.status as SettlementStatus;
      if (planStatus === "FUNDED") await stepPlan(tx, plan.id, "FUNDED", "MILESTONE_PENDING");
      else if (planStatus === "PARTIALLY_SETTLED") await stepPlan(tx, plan.id, "PARTIALLY_SETTLED", "MILESTONE_PENDING");
      await stepPlan(tx, plan.id, "MILESTONE_PENDING", "MILESTONE_VERIFIED");

      await tx
        .updateTable("settlement_milestones")
        .set({ status: "verified", approved_at: new Date().toISOString() })
        .where("id", "=", milestoneId)
        .where("status", "=", "pending")
        .execute();

      await appendAuditEvent(tx, {
        actorType: "system",
        actorId,
        action: "settlement.milestone_verified",
        entityType: "settlement_milestone",
        entityId: milestoneId,
      });
      await enqueueEvent(tx, {
        eventName: "settlement.milestone_ready.v1",
        aggregateType: "settlement_milestone",
        aggregateId: milestoneId,
        idempotencyKey: `settlement.milestone_ready:${milestoneId}`,
        payload: { milestoneId, settlementPlanId: plan.id },
      });
    });
}

const SETTLE_PATH: TransactionStatus[] = ["proposed", "agreed", "funding", "funded", "fulfilling", "settled"];

async function advanceTransactionToSettled(tx: Tx, transactionId: string, actorId: string): Promise<void> {
  const txn = await tx.selectFrom("transactions").selectAll().where("id", "=", transactionId).executeTakeFirst();
  if (!txn) return;
  let current = txn.status as TransactionStatus;
  const start = SETTLE_PATH.indexOf(current);
  if (start < 0) return;
  for (let i = start; i < SETTLE_PATH.length - 1; i++) {
    const from = SETTLE_PATH[i]!;
    const to = SETTLE_PATH[i + 1]!;
    assertTransition("transaction", TRANSACTION_TRANSITIONS, from, to);
    await tx.updateTable("transactions").set({ status: to }).where("id", "=", transactionId).where("status", "=", from).execute();
    current = to;
  }
  await appendAuditEvent(tx, {
    actorType: "system",
    actorId,
    action: "transaction.settled",
    entityType: "transaction",
    entityId: transactionId,
  });
  await enqueueEvent(tx, {
    eventName: "transaction.settled.v1",
    aggregateType: "transaction",
    aggregateId: transactionId,
    idempotencyKey: `transaction.settled:${transactionId}`,
    payload: { transactionId },
  });
}

export interface ReleaseMilestoneInput {
  milestoneId: string;
  amountMinor: number;
  currency: string;
  actorId: string;
  externalTransactionRef?: string | null;
  reason: string;
}

export interface ReleaseMilestoneResult {
  planSettled: boolean;
  transactionSettled: boolean;
}

/**
 * Release a verified milestone: request approval → release, pay out the
 * milestone, and settle the plan (and its transaction) once every milestone is
 * released; otherwise mark the plan partially settled (§20). Audit-backed.
 */
export async function releaseMilestone(input: ReleaseMilestoneInput): Promise<ReleaseMilestoneResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const milestone = await tx
        .selectFrom("settlement_milestones")
        .selectAll()
        .where("id", "=", input.milestoneId)
        .executeTakeFirstOrThrow();
      const plan = await planRow(tx, milestone.settlement_plan_id);

      await stepPlan(tx, plan.id, "MILESTONE_VERIFIED", "AWAITING_RELEASE_APPROVAL");
      await enqueueEvent(tx, {
        eventName: "settlement.release_requested.v1",
        aggregateType: "settlement_milestone",
        aggregateId: input.milestoneId,
        idempotencyKey: `settlement.release_requested:${input.milestoneId}`,
        payload: { milestoneId: input.milestoneId, settlementPlanId: plan.id, amountMinor: input.amountMinor },
      });
      await stepPlan(tx, plan.id, "AWAITING_RELEASE_APPROVAL", "RELEASE_PENDING");

      await tx
        .updateTable("settlement_milestones")
        .set({
          status: "released",
          released_at: new Date().toISOString(),
          external_transaction_ref: input.externalTransactionRef ?? null,
        })
        .where("id", "=", input.milestoneId)
        .where("status", "=", "verified")
        .execute();

      const remaining = await tx
        .selectFrom("settlement_milestones")
        .select(({ fn }) => fn.countAll<string>().as("n"))
        .where("settlement_plan_id", "=", plan.id)
        .where("status", "!=", "released")
        .executeTakeFirstOrThrow();
      const allReleased = Number(remaining.n) === 0;

      await stepPlan(tx, plan.id, "RELEASE_PENDING", allReleased ? "SETTLED" : "PARTIALLY_SETTLED");

      await appendAuditEvent(tx, {
        actorType: "operator",
        actorId: input.actorId,
        action: "settlement.released",
        entityType: "settlement_milestone",
        entityId: input.milestoneId,
        inputHash: null,
      });
      await enqueueEvent(tx, {
        eventName: "settlement.released.v1",
        aggregateType: "settlement_milestone",
        aggregateId: input.milestoneId,
        idempotencyKey: `settlement.released:${input.milestoneId}`,
        payload: { milestoneId: input.milestoneId, settlementPlanId: plan.id, reason: input.reason },
      });

      let transactionSettled = false;
      if (allReleased) {
        await advanceTransactionToSettled(tx, plan.transaction_id, input.actorId);
        transactionSettled = true;
      }
      return { planSettled: allReleased, transactionSettled };
    });
}
