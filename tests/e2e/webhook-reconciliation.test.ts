import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  fundSettlementPlan,
  addMilestone,
  verifyMilestone,
  markMilestoneReleasePending,
  releaseMilestone,
  setMilestoneProviderRef,
  getMilestone,
  getSettlementPlan,
  createAssetTransferPlan,
  recordAssetTransferResult,
  getAssetTransferPlan,
} from "@opportunity-os/db";
import type { MilestoneRecipient } from "@opportunity-os/contracts";
import { WebhooksService } from "../../apps/api/src/webhooks/webhooks.service";

/**
 * ST-13 recipient-level webhook reconciliation. Drives the reconcile step
 * directly (signature verification is covered by scripts/verify-*-provider.ts
 * and doesn't depend on the DB): Circle split releases wait for every
 * recipient, a failed recipient disputes, Stripe Transfer reversals are
 * recorded on the recipient, a Stripe capture with unpaid split recipients is
 * not auto-released, and Circle notifications also finalize NFT asset transfers.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const AMOUNT = 10000;

function webhooks(): WebhooksService {
  // Reconciliation touches neither dependency (signal intake / outbound messaging).
  return new WebhooksService({} as never, {} as never);
}

async function transaction(amountMinor: number): Promise<string> {
  const { opportunityId } = await upsertGraphOpportunity({
    kind: "arbitrage",
    dedupeKey: `webhook-recon-${randomUUID()}`,
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
  return txn.id;
}

/** A funded plan with one verified, two-recipient split milestone. */
async function verifiedSplitMilestone(railFamily: "stablecoin" | "fiat") {
  const transactionId = await transaction(AMOUNT);
  const plan = await getDb()
    .insertInto("settlement_plans")
    .values({
      transaction_id: transactionId,
      rail_family: railFamily,
      provider: railFamily === "fiat" ? "stripe" : "stablecoin",
      asset: railFamily === "fiat" ? "USD" : "USDC",
      total_amount: { amount: AMOUNT, currency: "USD" },
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
    amount: { kind: "amount", value: AMOUNT },
    releaseConditions: { all: [{ predicate: { type: "shipment_delivered" } }] },
    recipients: [
      { address: "0xaaa", amount: { kind: "percentage", value: 60 }, counterpartyId: null },
      { address: "0xbbb", amount: { kind: "percentage", value: 40 }, counterpartyId: null },
    ],
  });
  await verifyMilestone(milestone.id, "system");
  return { planId: plan.id, milestoneId: milestone.id };
}

function executed(refA: string, refB: string, payoutStatus: "pending" | "confirmed"): MilestoneRecipient[] {
  return [
    { address: "0xaaa", amount: { kind: "percentage", value: 60 }, counterpartyId: null, externalRef: refA, payoutStatus },
    { address: "0xbbb", amount: { kind: "percentage", value: 40 }, counterpartyId: null, externalRef: refB, payoutStatus },
  ];
}

async function recipientsOf(milestoneId: string): Promise<MilestoneRecipient[]> {
  return (await getMilestone(milestoneId))!.recipients_json as MilestoneRecipient[];
}

describe.skipIf(!HAS_DB)("recipient-level webhook reconciliation (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("Circle: a split milestone releases only once every recipient transfer is COMPLETE", async () => {
    const { planId, milestoneId } = await verifiedSplitMilestone("stablecoin");
    const [txA, txB] = [randomUUID(), randomUUID()];
    await markMilestoneReleasePending({ milestoneId, externalTransactionRef: txA, executedRecipients: executed(txA, txB, "pending") });

    const service = webhooks();
    await service.reconcileCircleTransaction(txA, "COMPLETE");
    expect((await getMilestone(milestoneId))!.status).toBe("verified"); // txB still in flight
    expect((await recipientsOf(milestoneId)).map((r) => r.payoutStatus)).toEqual(["confirmed", "pending"]);

    await service.reconcileCircleTransaction(txB, "SENT"); // non-terminal: ignored
    expect((await getMilestone(milestoneId))!.status).toBe("verified");

    await service.reconcileCircleTransaction(txB, "COMPLETE");
    const released = (await getMilestone(milestoneId))!;
    expect(released.status).toBe("released");
    expect(released.external_transaction_ref).toBe(txA);
    expect((released.recipients_json as MilestoneRecipient[]).map((r) => r.payoutStatus)).toEqual(["confirmed", "confirmed"]);
    expect((await getSettlementPlan(planId))!.status).toBe("SETTLED");

    // Redelivery is an idempotent no-op.
    await service.reconcileCircleTransaction(txB, "COMPLETE");
    expect((await getMilestone(milestoneId))!.status).toBe("released");
  });

  it("Circle: one failed recipient transfer disputes the milestone and blocks release", async () => {
    const { planId, milestoneId } = await verifiedSplitMilestone("stablecoin");
    const [txA, txB] = [randomUUID(), randomUUID()];
    await markMilestoneReleasePending({ milestoneId, externalTransactionRef: txA, executedRecipients: executed(txA, txB, "pending") });

    const service = webhooks();
    await service.reconcileCircleTransaction(txB, "FAILED");
    expect((await getMilestone(milestoneId))!.status).toBe("disputed");
    expect((await getSettlementPlan(planId))!.status).toBe("DISPUTED");

    // The sibling landing afterwards is recorded but cannot release a disputed milestone.
    await service.reconcileCircleTransaction(txA, "COMPLETE");
    expect((await getMilestone(milestoneId))!.status).toBe("disputed");
    expect((await recipientsOf(milestoneId)).map((r) => r.payoutStatus)).toEqual(["confirmed", "failed"]);
  });

  it("Stripe: a Transfer reversal is recorded on its recipient without touching the released milestone", async () => {
    const { milestoneId } = await verifiedSplitMilestone("fiat");
    const [trA, trB] = [`tr_${randomUUID()}`, `tr_${randomUUID()}`];
    await releaseMilestone({
      milestoneId,
      amountMinor: AMOUNT,
      currency: "USD",
      actorId: "operator-1",
      externalTransactionRef: `pi_${randomUUID()}`,
      reason: "test",
      executedRecipients: executed(trA, trB, "confirmed"),
    });

    const service = webhooks();
    const event = (type: string, object: Record<string, unknown>) => ({ id: `evt_${randomUUID()}`, type, data: { object } }) as unknown as Stripe.Event;
    await service.reconcileStripeEvent(event("transfer.reversed", { id: trB, reversed: false, amount_reversed: 1000 }));
    expect((await recipientsOf(milestoneId)).map((r) => r.payoutStatus)).toEqual(["confirmed", "partially_reversed"]);

    await service.reconcileStripeEvent(event("transfer.reversed", { id: trB, reversed: true, amount_reversed: 4000 }));
    expect((await recipientsOf(milestoneId)).map((r) => r.payoutStatus)).toEqual(["confirmed", "reversed"]);
    expect((await getMilestone(milestoneId))!.status).toBe("released");
  });

  it("Stripe: a late capture does not auto-release a split whose Transfers were never created", async () => {
    const { milestoneId } = await verifiedSplitMilestone("fiat");
    const pi = `pi_${randomUUID()}`;
    await setMilestoneProviderRef(milestoneId, pi);

    const event = { id: `evt_${randomUUID()}`, type: "payment_intent.succeeded", data: { object: { id: pi } } } as unknown as Stripe.Event;
    await webhooks().reconcileStripeEvent(event);
    expect((await getMilestone(milestoneId))!.status).toBe("verified");
  });

  it("Circle: a notification for a CircleNftRail transfer finalizes its asset transfer plan", async () => {
    const transactionId = await transaction(0);
    const plan = await createAssetTransferPlan({
      transactionId,
      provider: "nft-circle",
      asset: { kind: "nft", chain: "BASE-SEPOLIA", locator: "0xcontract:1", metadataUri: null },
      toAddress: "0xbuyer",
    });
    const circleTx = randomUUID();
    await recordAssetTransferResult({ id: plan.id, status: "pending", externalRef: circleTx, actorId: "operator-1" });

    await webhooks().reconcileCircleTransaction(circleTx, "COMPLETE");
    const final = (await getAssetTransferPlan(plan.id))!;
    expect(final.status).toBe("confirmed");
    expect(final.external_ref).toBe(circleTx);
  });
});
