import { describe, it, expect, afterAll } from "vitest";
import {
  createSignal,
  resolveSignal,
  recordOutcome,
  outcomeStats,
  getDb,
  closeDb,
} from "@opportunity-os/db";
import { synthesizeOpportunities } from "@opportunity-os/discovery";

/**
 * §transaction-discovery — a demand signal and a supply signal from different
 * channels (no marketplace listing, no mission) are captured, projected, and
 * synthesized into an opportunity; then an outcome is recorded. Skips without
 * DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();

describe.skipIf(!HAS_DB)("signals -> synthesis -> outcome (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("synthesizes an opportunity from independent demand + supply signals", async () => {
    const demand = await createSignal({
      channel: "user_submitted",
      kind: "demand",
      sourceId: `buyer-${RUN}`,
      externalRef: `wtb-${RUN}`,
      title: null,
      description: "Need a 27-inch 4K monitor under $220, delivered this week.",
      category: "electronics",
      priceMinor: 22000,
      currency: "USD",
      contentHash: `hd-${RUN}`,
      sourceReliability: 0.7,
    });
    const supply = await createSignal({
      channel: "merchant_feed",
      kind: "supply",
      sourceId: `seller-${RUN}`,
      externalRef: `inv-${RUN}`,
      title: "Refurbished 27in 4K monitor",
      description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
      category: "electronics",
      priceMinor: 18900,
      currency: "USD",
      contentHash: `hs-${RUN}`,
      sourceReliability: 0.6,
    });

    expect(await outboxCount("signal.captured.v1", demand.signalId)).toBe(1);

    const demandEntity = await resolveSignal(demand.signalId);
    const supplyEntity = await resolveSignal(supply.signalId);
    expect(demandEntity?.entityType).toBe("demand");
    expect(supplyEntity?.entityType).toBe("supply");
    expect(await outboxCount("signal.resolved.v1", demand.signalId)).toBe(1);

    const result = await synthesizeOpportunities();
    expect(result.opportunitiesPersisted).toBeGreaterThanOrEqual(1);

    const match = await getDb()
      .selectFrom("matches")
      .select(["id"])
      .where("demand_id", "=", demandEntity!.entityId)
      .where("supply_id", "=", supplyEntity!.entityId)
      .executeTakeFirstOrThrow();
    const opp = await getDb()
      .selectFrom("opportunities")
      .selectAll()
      .where("match_id", "=", match.id)
      .executeTakeFirstOrThrow();
    expect(opp.status).toBe("qualified");
    expect(Number(opp.overall_score)).toBeGreaterThan(0);

    // Record a realized outcome for the synthesized opportunity.
    const outcome = await recordOutcome({
      opportunityId: opp.id,
      transactionId: null,
      status: "won",
      realizedAmountMinor: 22000,
      realizedProfitMinor: 4000,
      daysToClose: 5,
      shippingCostMinor: 1500,
      currency: "USD",
      notes: null,
    });
    expect(await outboxCount("outcome.recorded.v1", outcome.outcomeId)).toBe(1);

    const stats = await outcomeStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.won).toBeGreaterThanOrEqual(1);
    expect(stats.winRate).toBeGreaterThan(0);
  });
});

async function outboxCount(eventName: string, aggregateId: string): Promise<number> {
  const rows = await getDb()
    .selectFrom("outbox")
    .select(["id"])
    .where("event_name", "=", eventName)
    .where("aggregate_id", "=", aggregateId)
    .execute();
  return rows.length;
}
