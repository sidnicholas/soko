import { describe, it, expect, afterAll } from "vitest";
import { createSignal, resolveSignal, getEntityIdForMember, listEdgesFrom, closeDb } from "@opportunity-os/db";
import { resolveEntities, buildGraphEdges } from "@opportunity-os/discovery";

/**
 * §ADR-024 — derived market-graph edges: SUBSTITUTE_OF (similar items), ARBITRAGE
 * (price spread on one item), BUNDLE_AVAILABLE (multiple sellers). Skips without
 * DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();
const XM4_DESC = "sony wh1000xm4 wireless noise cancelling headphones";
const XM5_DESC = "sony wh1000xm5 wireless noise cancelling headphones";

async function supplySignal(source: string, ref: string, desc: string, priceMinor: number): Promise<string> {
  const sig = await createSignal({
    channel: "merchant_feed", kind: "supply", sourceId: source, externalRef: ref,
    title: desc, description: desc, category: "electronics", priceMinor, currency: "USD",
    contentHash: `${ref}-${priceMinor}`, sourceReliability: 0.6,
  });
  return (await resolveSignal(sig.signalId))!.entityId; // supply row id
}

describe.skipIf(!HAS_DB)("market graph edges (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("derives SUBSTITUTE_OF, ARBITRAGE, and BUNDLE_AVAILABLE", async () => {
    // XM4 from two sources at different prices -> one entity: arbitrage + bundle.
    const xm4a = await supplySignal(`a-${RUN}`, `xm4a-${RUN}`, XM4_DESC, 10000);
    await supplySignal(`b-${RUN}`, `xm4b-${RUN}`, XM4_DESC, 20000);
    // XM5: similar but distinct item -> substitute of XM4.
    const xm5 = await supplySignal(`c-${RUN}`, `xm5-${RUN}`, XM5_DESC, 15000);

    await resolveEntities();
    await buildGraphEdges();

    const entXm4 = (await getEntityIdForMember("supply", xm4a))!;
    const entXm5 = (await getEntityIdForMember("supply", xm5))!;
    expect(entXm4).not.toBe(entXm5); // distinct canonical entities

    const edges = await listEdgesFrom("entity", entXm4);
    expect(edges.some((e) => e.relation === "SUBSTITUTE_OF" && e.dst_id === entXm5)).toBe(true);
    expect(edges.some((e) => e.relation === "ARBITRAGE")).toBe(true);
    expect(edges.some((e) => e.relation === "BUNDLE_AVAILABLE")).toBe(true);

    // The arbitrage edge weight is the price spread (max-min)/max = 0.5 here.
    const arb = edges.find((e) => e.relation === "ARBITRAGE")!;
    expect(Number(arb.weight)).toBeCloseTo(0.5, 6);
  });
});
