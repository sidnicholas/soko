import { describe, it, expect, afterAll } from "vitest";
import { createSignal, resolveSignal, getEntityIdForMember, listOpportunitiesForOperator, getDb, closeDb } from "@opportunity-os/db";
import { resolveEntities, buildGraphEdges, opportunitiesFromGraph } from "@opportunity-os/discovery";

/**
 * §deals — market-graph edges become first-class opportunities on the operator
 * feed: cross-entity ARBITRAGE (buy cheap, sell into dearer substitute) and
 * BUNDLE (aggregate sellers). Skips without DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();
const XM4 = "sony wh1000xm4 wireless noise cancelling headphones";
const XM5 = "sony wh1000xm5 wireless noise cancelling headphones";

async function supply(source: string, ref: string, desc: string, priceMinor: number): Promise<string> {
  const sig = await createSignal({
    channel: "merchant_feed", kind: "supply", sourceId: source, externalRef: ref,
    title: desc, description: desc, category: "electronics", priceMinor, currency: "USD",
    contentHash: `${ref}-${priceMinor}`, sourceReliability: 0.6,
  });
  return (await resolveSignal(sig.signalId))!.entityId;
}

describe.skipIf(!HAS_DB)("graph deals (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("creates arbitrage + bundle opportunities from graph edges", async () => {
    const xm4a = await supply(`d-a-${RUN}`, `d-a-${RUN}`, XM4, 10000);
    await supply(`d-b-${RUN}`, `d-b-${RUN}`, XM4, 20000);
    const xm5 = await supply(`d-c-${RUN}`, `d-c-${RUN}`, XM5, 15000);

    await resolveEntities();
    await buildGraphEdges();
    const deals = await opportunitiesFromGraph();
    expect(deals.arbitrage).toBeGreaterThanOrEqual(1);
    expect(deals.bundle).toBeGreaterThanOrEqual(1);

    const entXm4 = (await getEntityIdForMember("supply", xm4a))!;
    const entXm5 = (await getEntityIdForMember("supply", xm5))!;

    // Arbitrage: buy XM4 @10000, sell into XM5 substitute @15000 -> profit 5000.
    const arb = await getDb().selectFrom("opportunities").selectAll().where("dedupe_key", "=", `arb:${entXm4}:${entXm5}`).executeTakeFirstOrThrow();
    expect(arb.kind).toBe("arbitrage");
    expect(arb.status).toBe("qualified");
    expect(arb.match_id).toBeNull();
    expect(arb.expected_net_profit).toMatchObject({ amount: 5000 });

    // Bundle: XM4 entity has 2 sellers (10000, 20000) -> median 15000, savings 5000.
    const bundle = await getDb().selectFrom("opportunities").selectAll().where("dedupe_key", "=", `bundle:${entXm4}`).executeTakeFirstOrThrow();
    expect(bundle.kind).toBe("bundle");
    expect(bundle.expected_net_profit).toMatchObject({ amount: 5000 });

    // Both surface on the operator feed.
    const feed = await listOpportunitiesForOperator();
    expect(feed.some((o) => o.id === arb.id)).toBe(true);
  });
});
