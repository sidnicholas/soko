import { describe, it, expect, afterAll } from "vitest";
import {
  createSignal,
  resolveSignal,
  getEntity,
  getEntityIdForMember,
  entityPriceStats,
  listComparableSupply,
  getDb,
  closeDb,
} from "@opportunity-os/db";
import { resolveEntities } from "@opportunity-os/discovery";

/**
 * §market-graph — the same item observed from two sources resolves to one
 * canonical entity with price history + a PRICE_COMPARABLE edge. Skips without
 * DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();
const TITLE = "Sony WH1000XM4 wireless headphones";
const DESC = "Sony WH1000XM4 over-ear wireless noise cancelling headphones";

describe.skipIf(!HAS_DB)("market graph (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("resolves same-item supply from two sources into one entity with comparables", async () => {
    const a = await createSignal({
      channel: "merchant_feed", kind: "supply", sourceId: `srcA-${RUN}`, externalRef: `a-${RUN}`,
      title: TITLE, description: DESC, category: "electronics", priceMinor: 24900, currency: "USD",
      contentHash: `ca-${RUN}`, sourceReliability: 0.6,
    });
    const b = await createSignal({
      channel: "public_web", kind: "supply", sourceId: `srcB-${RUN}`, externalRef: `b-${RUN}`,
      title: TITLE, description: DESC, category: "electronics", priceMinor: 21900, currency: "USD",
      contentHash: `cb-${RUN}`, sourceReliability: 0.6,
    });
    const supplyA = (await resolveSignal(a.signalId))!.entityId;
    const supplyB = (await resolveSignal(b.signalId))!.entityId;

    await resolveEntities();

    const entA = await getEntityIdForMember("supply", supplyA);
    const entB = await getEntityIdForMember("supply", supplyB);
    expect(entA).not.toBeNull();
    expect(entA).toBe(entB); // one canonical entity across two sources

    const stats = await entityPriceStats(entA!);
    expect(stats?.count).toBeGreaterThanOrEqual(2);
    expect(stats?.minMinor).toBe(21900);
    expect(stats?.maxMinor).toBe(24900);

    const comparables = await listComparableSupply(entA!, supplyA);
    expect(comparables.some((c) => c.id === supplyB)).toBe(true);

    const edges = await getDb()
      .selectFrom("graph_edges")
      .select(["id"])
      .where("src_type", "=", "supply")
      .where("src_id", "=", supplyA)
      .where("dst_id", "=", supplyB)
      .where("relation", "=", "PRICE_COMPARABLE")
      .execute();
    expect(edges).toHaveLength(1);

    const entity = await getEntity(entA!);
    expect(entity?.category).toBe("electronics");
  });
});
