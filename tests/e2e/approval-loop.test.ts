import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AuditEvent, DemandSpecification } from "@opportunity-os/contracts";
import {
  createMission,
  createApproval,
  decideApproval,
  getApprovalById,
  listUndeliveredApprovals,
  listOpportunitiesByMission,
  proposeTransaction,
  getDb,
  closeDb,
} from "@opportunity-os/db";
import { mintApprovalToken, verifyApprovalToken } from "@opportunity-os/auth";
import { sha256Hex, canonicalJson, verifyChain } from "@opportunity-os/audit";
import { getConfig } from "@opportunity-os/config";
import { runDiscoveryCycle } from "@opportunity-os/discovery";
import { deliverPendingApprovals } from "../../apps/worker-notifications/src/deliver";

/**
 * §14/§11.2 human-controlled execution against live Postgres: request approval →
 * deliver once → approve (mint token) → propose transaction gated on the token,
 * with a hash-chained audit event. Skips without DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();
const SECRET = getConfig().security.approvalTokenSecret;

async function outboxIds(eventName: string, aggregateId: string): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("outbox")
    .select(["id"])
    .where("event_name", "=", eventName)
    .where("aggregate_id", "=", aggregateId)
    .execute();
  return rows.map((r) => r.id);
}

describe.skipIf(!HAS_DB)("approval loop (live postgres)", () => {
  let operatorId: string;
  let agentId: string;
  let opportunityId: string;
  const terms = { action: "propose_transaction", grossAmountMinor: 22000, currency: "USD" };

  const payloadHash = () =>
    sha256Hex(canonicalJson({ action: terms.action, opportunityId, grossAmountMinor: terms.grossAmountMinor, currency: terms.currency }));

  beforeAll(async () => {
    const [operator, agent] = await Promise.all([
      getDb().insertInto("users").values({ email: `appr-op-${RUN}@t.test`, display_name: "Op", role: "operator" }).returning(["id"]).executeTakeFirstOrThrow(),
      getDb().insertInto("users").values({ email: `appr-ag-${RUN}@t.test`, display_name: "Ag", role: "agent" }).returning(["id"]).executeTakeFirstOrThrow(),
    ]);
    operatorId = operator.id;
    agentId = agent.id;

    const spec: DemandSpecification = {
      what: { description: "Need a 27-inch 4K monitor under $220, delivered this week." },
      budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
      quality: { constraints: [{ field: "category", operator: "eq", value: "electronics", hard: true }] },
      timing: { urgency: "days" },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: true, maySend: false },
    };
    const mission = await createMission({
      ownerUserId: operatorId, title: "monitor", rawIntent: spec.what.description,
      autonomyPolicy: "discover_only", demandSpec: spec, changedBy: operatorId,
    });
    await runDiscoveryCycle({
      missionId: mission.missionId, query: "",
      demand: { description: spec.what.description, category: "electronics", targetPriceMinor: null, maxBudgetMinor: 22000, currency: "USD", urgencyScore: 0.6 },
    });
    const opps = await listOpportunitiesByMission(mission.missionId);
    opportunityId = opps[0]!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("runs request -> deliver -> approve -> gated proposal with an audit chain", async () => {
    // 1. Agent requests approval; approval.requested.v1 is emitted.
    const approval = await createApproval({
      requestedByAgent: agentId,
      actionType: "propose_transaction",
      entityType: "opportunity",
      entityId: opportunityId,
      payloadHash: payloadHash(),
      humanReadableSummary: "Propose a broker transaction for the monitor opportunity",
      riskSummary: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await outboxIds("approval.requested.v1", approval.id)).toHaveLength(1);

    // 2. Notifications worker delivers it exactly once.
    expect((await listUndeliveredApprovals()).some((a) => a.id === approval.id)).toBe(true);
    expect(await deliverPendingApprovals()).toBeGreaterThanOrEqual(1);
    expect((await listUndeliveredApprovals()).some((a) => a.id === approval.id)).toBe(false);

    // 3. Operator approves; a token is minted bound to the exact payload.
    await decideApproval(approval.id, {
      status: "approved", decision: "approve", event: "approval.approved.v1", decidedBy: operatorId, metadata: {},
    });
    const token = mintApprovalToken(SECRET, {
      approvalId: approval.id, action: "propose_transaction", entityType: "opportunity",
      entityId: opportunityId, payloadHash: payloadHash(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: payloadHash() }).ok).toBe(true);
    // A token cannot authorize a mutated command.
    expect(verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: "0".repeat(64) }).ok).toBe(false);

    // 4. Gated proposal: verify token, confirm approval state, create transaction + audit.
    const verified = verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: payloadHash() });
    expect(verified.ok).toBe(true);
    const stored = await getApprovalById(verified.claims!.approvalId);
    expect(stored?.status).toBe("approved");

    const result = await proposeTransaction({
      opportunityId, grossAmountMinor: terms.grossAmountMinor, currency: terms.currency,
      termsHash: payloadHash(), decidedBy: operatorId,
    });

    const txn = await getDb().selectFrom("transactions").selectAll().where("id", "=", result.transactionId).executeTakeFirstOrThrow();
    expect(txn.status).toBe("proposed");
    expect(txn.terms_hash).toBe(payloadHash());
    expect(await outboxIds("transaction.proposed.v1", result.transactionId)).toHaveLength(1);

    const opp = await getDb().selectFrom("opportunities").select(["status"]).where("id", "=", opportunityId).executeTakeFirstOrThrow();
    expect(opp.status).toBe("approved");

    // 5. Audit-backed execution: the event is on a valid hash chain.
    const auditRows = await getDb().selectFrom("audit_events").selectAll().orderBy("created_at", "asc").execute();
    const mine = auditRows.filter((r) => r.entity_id === result.transactionId && r.action === "transaction.proposed");
    expect(mine).toHaveLength(1);
    expect(verifyChain(auditRows as unknown as AuditEvent[])).toEqual({ ok: true });
  });
});
