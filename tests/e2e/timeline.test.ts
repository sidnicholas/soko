import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  fundSettlementPlan,
  addMilestone,
  appendEvidence,
  verifyMilestone,
  releaseMilestone,
  createApproval,
  decideApproval,
  createMission,
  setMissionStatus,
  enqueueEvent,
  transactionTimeline,
  missionTimeline,
} from "@opportunity-os/db";
import { makeAttestationVerifier } from "@opportunity-os/verifiers-sdk";
import type { DemandSpecification } from "@opportunity-os/contracts";

/**
 * Phase 4 timelines — the aggregator merges audit trail, outbox (missions,
 * approvals), evidence ledger and mission versions into one ordered history,
 * reaching objects hanging off the root (plans, milestones, approvals).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

const SPEC: DemandSpecification = {
  what: { description: "Need a 27-inch 4K monitor under $220." },
  budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
  quality: { constraints: [] },
  timing: { urgency: "days" },
  payment: { acceptableMethods: ["card"] },
  fulfillment: { type: "ship" },
  flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
  negotiationAuthorization: { mayPrepare: true, maySend: false },
} as DemandSpecification;

function isSorted(ats: string[]): boolean {
  return ats.every((at, i) => i === 0 || ats[i - 1]! <= at);
}

describe.skipIf(!HAS_DB)("entity timelines (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("transaction timeline reaches its settlement milestones, evidence and approvals", async () => {
    const OPERATOR = (
      await getDb()
        .insertInto("users")
        .values({ email: `timeline-op-${RUN}@t.test`, display_name: "Op", role: "operator" })
        .returning(["id"])
        .executeTakeFirstOrThrow()
    ).id;
    const amountMinor = 5000;
    const { opportunityId } = await upsertGraphOpportunity({
      kind: "arbitrage",
      dedupeKey: `timeline-${RUN}`,
      expectedRevenueMinor: amountMinor,
      expectedDirectCostMinor: 0,
      expectedNetProfitMinor: amountMinor,
      currency: "USD",
      overallScore: 0.5,
      closeProbability: 0.5,
      customerValueScore: 0.5,
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
        rail_family: "onchain_programmable",
        provider: "onchain-programmable",
        asset: "USDC",
        total_amount: { amount: amountMinor, currency: "USD" },
        status: "DRAFT",
        human_release_policy: "over_threshold",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    await fundSettlementPlan(plan.id, "operator-1");
    const milestone = await addMilestone({
      settlementPlanId: plan.id,
      sequence: 0,
      name: "delivery",
      amount: { kind: "amount", value: amountMinor },
      releaseConditions: { all: [{ predicate: { type: "shipment_delivered" } }] },
    });
    await appendEvidence({
      entityType: "settlement_milestone",
      entityId: milestone.id,
      claim: makeAttestationVerifier().verify({ predicateType: "shipment_delivered", payload: { attested: true, delivered: true } })!,
    });
    await verifyMilestone(milestone.id, "system");
    const approval = await createApproval({
      requestedByAgent: "agent-1",
      actionType: "release_milestone",
      entityType: "settlement_milestone",
      entityId: milestone.id,
      payloadHash: "p".repeat(64),
      humanReadableSummary: `Release ${RUN}`,
      riskSummary: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await decideApproval(approval.id, {
      status: "approved",
      decision: "approve",
      event: "approval.approved.v1",
      decidedBy: OPERATOR,
      metadata: {},
    });
    await releaseMilestone({ milestoneId: milestone.id, amountMinor, currency: "USD", actorId: "operator-1", reason: "test" });

    const entries = (await transactionTimeline(txn.id))!;
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("settlement.funded");
    expect(actions).toContain("settlement.released");
    expect(actions).toContain("evidence.captured");
    expect(actions).toContain("approval.requested");
    expect(actions).toContain("approval.approved");
    expect(entries.find((e) => e.action === "approval.requested")!.summary).toBe(`Release ${RUN}`);
    expect(entries.find((e) => e.action === "approval.approved")!.actor).toBe(OPERATOR);
    expect(entries.filter((e) => e.source === "audit").every((e) => e.hash)).toBe(true);
    expect(isSorted(entries.map((e) => e.at))).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length); // no duplicates across sources

    expect(await transactionTimeline(randomUUID())).toBeUndefined();
  });

  it("mission timeline shows creation, every constraints version and lifecycle changes", async () => {
    const user = await getDb()
      .insertInto("users")
      .values({ email: `timeline-${RUN}@t.test`, display_name: "Op", role: "operator" })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const { missionId } = await createMission({
      ownerUserId: user.id,
      title: "Monitor",
      rawIntent: "Need a monitor",
      autonomyPolicy: "discover_only",
      demandSpec: SPEC,
      changedBy: user.id,
    });
    await setMissionStatus(missionId, "paused");
    await enqueueEvent(getDb(), {
      eventName: "mission.paused.v1",
      aggregateType: "mission",
      aggregateId: missionId,
      idempotencyKey: `mission.pause:${missionId}:${RUN}`,
      payload: { missionId, from: "active", to: "paused" },
    });

    const entries = (await missionTimeline(missionId))!;
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("mission.created");
    expect(actions).toContain("mission.constraints_versioned");
    const paused = entries.find((e) => e.action === "mission.paused")!;
    expect(paused.summary).toBe("active → paused");
    expect(isSorted(entries.map((e) => e.at))).toBe(true);

    expect(await missionTimeline(randomUUID())).toBeUndefined();
  });
});
