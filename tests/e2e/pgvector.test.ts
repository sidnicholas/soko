import { describe, it, expect, afterAll } from "vitest";
import { createSignal, resolveSignal, getEntityIdForMember, listEdgesFrom, nearestEntitiesByVector, closeDb } from "@opportunity-os/db";
import { resolveEntities, buildGraphEdges } from "@opportunity-os/discovery";

/**
 * §ADR-026 — pgvector backend: <=> nearest-neighbour drives SUBSTITUTE_OF edges.
 * Runs ONLY in the pgvector CI job (PGVECTOR_TEST=1, EMBEDDING_BACKEND=pgvector
 * on the pgvector/pgvector image); skipped everywhere else (no `vector` ext).
 */
const RUN = process.env.PGVECTOR_TEST === "1" && Boolean(process.env.DATABASE_URL);
const STAMP = Date.now();
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

describe.skipIf(!RUN)("pgvector nearest-neighbour (ci)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("links similar items via <=> as SUBSTITUTE_OF", async () => {
    const xm4 = await supply(`pv-a-${STAMP}`, `pv-a-${STAMP}`, XM4, 24900);
    const xm5 = await supply(`pv-b-${STAMP}`, `pv-b-${STAMP}`, XM5, 21900);

    await resolveEntities(); // writes embedding_vec (pgvector backend)
    await buildGraphEdges(); // uses nearestEntitiesByVector

    const entXm4 = (await getEntityIdForMember("supply", xm4))!;
    const entXm5 = (await getEntityIdForMember("supply", xm5))!;
    expect(entXm4).not.toBe(entXm5);

    // Direct <=> query returns the sibling above threshold.
    const near = await nearestEntitiesByVector(entXm4, 10, 0.6);
    expect(near.some((n) => n.id === entXm5)).toBe(true);

    // And the derived edge exists.
    const edges = await listEdgesFrom("entity", entXm4);
    expect(edges.some((e) => e.relation === "SUBSTITUTE_OF" && e.dst_id === entXm5)).toBe(true);
  });
});
