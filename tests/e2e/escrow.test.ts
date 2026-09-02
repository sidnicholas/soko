import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  fundSettlementPlan,
  addMilestone,
  appendEvidence,
  listEvidenceClaims,
  listEvidenceLedger,
  verifyEvidenceChain,
  verifyMilestone,
  releaseMilestone,
  getSettlementPlan,
  getMilestone,
} from "@opportunity-os/db";
import { evaluateCondition, decideRelease } from "@opportunity-os/escrow";
import { makeAttestationVerifier, makeSignedDocumentVerifier, signDocument } from "@opportunity-os/verifiers-sdk";
import { mintApprovalToken, verifyApprovalToken } from "@opportunity-os/auth";
import { hashReleaseTerms } from "@opportunity-os/audit";
import type { EscrowCondition } from "@opportunity-os/contracts";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const SECRET = "escrow-e2e-secret";
const attestation = makeAttestationVerifier();
const esign = makeSignedDocumentVerifier(SECRET);

/** condition: shipped (basic) AND a verified e-signature on doc D. */
function condition(documentId: string): EscrowCondition {
  return {
    all: [
      { predicate: { type: "shipment_delivered" } },
      { predicate: { type: "document_signed", documentId }, minTrust: "verified" },
    ],
  };
}

async function fundedPlanWithMilestone(amountMinor: number, policy: string): Promise<{ planId: string; milestoneId: string; transactionId: string; documentId: string }> {
  const dedupe = `escrow-${randomUUID()}`;
  const { opportunityId } = await upsertGraphOpportunity({
    kind: "arbitrage",
    dedupeKey: dedupe,
    expectedRevenueMinor: amountMinor,
    expectedDirectCostMinor: 0,
    expectedNetProfitMinor: amountMinor,
    currency: "USD",
    overallScore: 0.8,
    closeProbability: 0.8,
    customerValueScore: 0.8,
    scoreVersion: "v1",
    nextAction: "settle",
    source: { test: true },
  });

  const txn = await getDb()
    .insertInto("transactions")
    .values({
      opportunity_id: opportunityId,
      buyer_id: null,
      seller_id: null,
      status: "proposed",
      terms_version: 0,
      terms_hash: "t".repeat(64),
      gross_amount: { amount: amountMinor, currency: "USD" },
      currency: "USD",
      platform_revenue: null,
      settlement_plan_id: null,
      fulfillment_plan_id: null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  const plan = await getDb()
    .insertInto("settlement_plans")
    .values({
      transaction_id: txn.id,
      rail_family: "stablecoin",
      provider: "test-net",
      asset: "USDC",
      total_amount: { amount: amountMinor, currency: "USD" },
      status: "DRAFT",
      human_release_policy: policy,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  await getDb().updateTable("transactions").set({ settlement_plan_id: plan.id }).where("id", "=", txn.id).execute();
  await fundSettlementPlan(plan.id, "operator-1");

  const documentId = `doc-${randomUUID()}`;
  const milestone = await addMilestone({
    settlementPlanId: plan.id,
    sequence: 0,
    name: "delivery",
    amount: { kind: "amount", value: amountMinor },
    releaseConditions: condition(documentId),
  });

  return { planId: plan.id, milestoneId: milestone.id, transactionId: txn.id, documentId };
}

/** Verify a milestone by submitting evidence through verifiers + the engine, exactly like the API. */
async function proveAndVerify(milestoneId: string, documentId: string): Promise<void> {
  const cond = (await getMilestone(milestoneId))!.release_conditions_json as EscrowCondition;

  // First evidence: shipment attestation only -> conditions not yet met.
  const shipped = attestation.verify({ predicateType: "shipment_delivered", payload: { attested: true, delivered: true } })!;
  await appendEvidence({ entityType: "settlement_milestone", entityId: milestoneId, claim: shipped, satisfies: { predicateType: "shipment_delivered" } });
  let evalResult = evaluateCondition(cond, await listEvidenceClaims("settlement_milestone", milestoneId));
  expect(evalResult.satisfied).toBe(false);

  // Second evidence: verified e-signature -> conditions met.
  const signed = esign.verify({ predicateType: "document_signed", payload: { documentId, signature: signDocument(SECRET, documentId) } })!;
  await appendEvidence({ entityType: "settlement_milestone", entityId: milestoneId, claim: signed, satisfies: { predicateType: "document_signed" } });
  evalResult = evaluateCondition(cond, await listEvidenceClaims("settlement_milestone", milestoneId));
  expect(evalResult.satisfied).toBe(true);

  await verifyMilestone(milestoneId, "system");
  expect((await getMilestone(milestoneId))!.status).toBe("verified");
}

describe.skipIf(!HAS_DB)("escrow condition/release engine (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("auto-releases a small milestone: evidence -> verify -> release -> settled, with an intact evidence chain", async () => {
    const { planId, milestoneId, transactionId, documentId } = await fundedPlanWithMilestone(5000, "over_threshold");
    expect((await getSettlementPlan(planId))!.status).toBe("FUNDED");

    await proveAndVerify(milestoneId, documentId);

    // Below the auto-release threshold -> no human token needed.
    const decision = decideRelease({
      humanReleasePolicy: "over_threshold",
      amountMinor: 5000,
      thresholdMinor: 100000,
      conditionSatisfied: true,
      disputed: false,
      now: new Date(),
    });
    expect(decision.decision).toBe("auto_release");

    const result = await releaseMilestone({ milestoneId, amountMinor: 5000, currency: "USD", actorId: "operator-1", reason: decision.reason });
    expect(result.planSettled).toBe(true);
    expect(result.transactionSettled).toBe(true);

    expect((await getSettlementPlan(planId))!.status).toBe("SETTLED");
    expect((await getMilestone(milestoneId))!.status).toBe("released");
    const settledTxn = await getDb().selectFrom("transactions").select("status").where("id", "=", transactionId).executeTakeFirstOrThrow();
    expect(settledTxn.status).toBe("settled");

    // The evidence ledger is an intact hash chain.
    const ledger = await listEvidenceLedger("settlement_milestone", milestoneId);
    expect(ledger).toHaveLength(2);
    expect(verifyEvidenceChain(ledger).ok).toBe(true);

    // A mutated evidence row breaks the chain.
    const tampered = [{ ...ledger[0]!, evidence_hash: "0".repeat(64) }, ledger[1]!];
    expect(verifyEvidenceChain(tampered).ok).toBe(false);

    // Money-movement + settlement events were emitted.
    const events = await getDb().selectFrom("outbox").select("event_name").where("aggregate_id", "in", [milestoneId, transactionId]).execute();
    const names = events.map((e) => e.event_name);
    expect(names).toContain("settlement.released.v1");
    expect(names).toContain("transaction.settled.v1");
  });

  it("requires a valid approval token to release above the threshold", async () => {
    const { milestoneId, documentId } = await fundedPlanWithMilestone(250000, "over_threshold");
    await proveAndVerify(milestoneId, documentId);

    const decision = decideRelease({
      humanReleasePolicy: "over_threshold",
      amountMinor: 250000,
      thresholdMinor: 100000,
      conditionSatisfied: true,
      disputed: false,
      now: new Date(),
    });
    expect(decision.decision).toBe("require_approval");

    const payloadHash = hashReleaseTerms({ milestoneId, amountMinor: 250000, currency: "USD" });
    // A token for a different amount must not authorize this release.
    const wrong = mintApprovalToken(SECRET, {
      approvalId: randomUUID(),
      action: "release_milestone",
      entityType: "settlement_milestone",
      entityId: milestoneId,
      payloadHash: hashReleaseTerms({ milestoneId, amountMinor: 1, currency: "USD" }),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(verifyApprovalToken(SECRET, wrong, { action: "release_milestone", payloadHash }).ok).toBe(false);

    // The correct, hash-matched token authorizes it.
    const token = mintApprovalToken(SECRET, {
      approvalId: randomUUID(),
      action: "release_milestone",
      entityType: "settlement_milestone",
      entityId: milestoneId,
      payloadHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(verifyApprovalToken(SECRET, token, { action: "release_milestone", payloadHash }).ok).toBe(true);

    const result = await releaseMilestone({ milestoneId, amountMinor: 250000, currency: "USD", actorId: "admin-1", reason: decision.reason });
    expect(result.planSettled).toBe(true);
  });
});
