import {
  listAvailableSupply,
  listOpenDemands,
  upsertEntity,
  linkEntityMember,
  recordPriceObservation,
  upsertGraphEdge,
  listEntityMembers,
  setEntityEmbedding,
  listEntityEmbeddings,
  entityPriceStats,
  entitySupplyAgg,
} from "@opportunity-os/db";
import { defaultEmbedding, cosineSimilarity } from "./embed";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("discovery:entities");

const STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, with: true, new: true, used: true, lot: true,
  set: true, pack: true, unit: true, units: true, grade: true, condition: true,
};

/**
 * Deterministic canonical key for entity resolution (§ market graph). Groups
 * observations of the same item by category + a normalized token signature.
 * A baseline until embedding similarity (pgvector) lands; documented in ADR-023.
 */
export function canonicalEntityKey(category: string | null, ...texts: string[]): string {
  const tokens = new Set<string>();
  for (const raw of texts.join(" ").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && !STOPWORDS[raw]) tokens.add(raw);
  }
  const signature = [...tokens].sort().join("-");
  return `${category ?? "uncategorized"}::${signature || "unknown"}`;
}

function readMinor(value: unknown): number | null {
  if (value && typeof value === "object" && "amount" in value && typeof value.amount === "number") return value.amount;
  return null;
}

function readCurrency(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "currency" in value && typeof value.currency === "string") return value.currency;
  return fallback;
}

export interface ResolveEntitiesResult {
  entitiesTouched: number;
  membersLinked: number;
  priceObservations: number;
  comparableEdges: number;
}

/**
 * Resolve supply + demand into canonical entities, record price observations,
 * and link same-entity supply listings with PRICE_COMPARABLE edges — the market
 * graph that powers comparables, price history, and (later) arbitrage.
 */
export async function resolveEntities(opts: { supplyLimit?: number; demandLimit?: number } = {}): Promise<ResolveEntitiesResult> {
  const supply = await listAvailableSupply(opts.supplyLimit ?? 500);
  const demands = await listOpenDemands(opts.demandLimit ?? 100);

  const touched = new Set<string>();
  let membersLinked = 0;
  let priceObservations = 0;
  let comparableEdges = 0;

  for (const s of supply) {
    const key = canonicalEntityKey(s.category, s.title, s.description);
    const entityId = await upsertEntity({ canonicalKey: key, kind: "product", category: s.category, title: s.title });
    await setEntityEmbedding(entityId, defaultEmbedding.embed(`${s.title} ${s.description}`));
    touched.add(entityId);
    await linkEntityMember(entityId, "supply", s.id);
    membersLinked++;

    const amount = readMinor(s.price);
    if (amount !== null) {
      await recordPriceObservation({ entityId, memberType: "supply", memberId: s.id, amountMinor: amount, currency: readCurrency(s.price, s.currency) });
      priceObservations++;
    }

    // Link this listing to other supply of the same entity (comparables).
    const members = await listEntityMembers(entityId);
    for (const m of members) {
      if (m.member_type !== "supply" || m.member_id === s.id) continue;
      await upsertGraphEdge({ srcType: "supply", srcId: s.id, dstType: "supply", dstId: m.member_id, relation: "PRICE_COMPARABLE" });
      await upsertGraphEdge({ srcType: "supply", srcId: m.member_id, dstType: "supply", dstId: s.id, relation: "PRICE_COMPARABLE" });
      comparableEdges += 2;
    }
  }

  for (const d of demands) {
    const key = canonicalEntityKey(d.category, d.description);
    const entityId = await upsertEntity({ canonicalKey: key, kind: "product", category: d.category, title: d.description.slice(0, 80) });
    await setEntityEmbedding(entityId, defaultEmbedding.embed(d.description));
    touched.add(entityId);
    await linkEntityMember(entityId, "demand", d.id);
    membersLinked++;
  }

  const result: ResolveEntitiesResult = { entitiesTouched: touched.size, membersLinked, priceObservations, comparableEdges };
  log.info(result, "discovery.entities.resolved");
  return result;
}

const SUBSTITUTE_MIN_SIM = 0.6;
const ARBITRAGE_MIN_SPREAD = 0.2;
const BUNDLE_MIN_SELLERS = 2;

export interface GraphEdgeResult {
  substitutes: number;
  arbitrage: number;
  bundles: number;
}

/**
 * Derive the higher-order market graph from resolved entities:
 *  - SUBSTITUTE_OF: same-category entities with cosine similarity >= threshold
 *  - ARBITRAGE: an entity whose price spread across observations is large enough
 *  - BUNDLE_AVAILABLE: an entity with enough distinct sellers to aggregate
 * Runs each lifecycle sweep after resolveEntities (§ ADR-024).
 */
export async function buildGraphEdges(): Promise<GraphEdgeResult> {
  const entities = await listEntityEmbeddings();

  // Substitutes: pairwise cosine within a category.
  const byCategory = new Map<string, typeof entities>();
  for (const e of entities) {
    const key = e.category ?? "uncategorized";
    const group = byCategory.get(key);
    if (group) group.push(e);
    else byCategory.set(key, [e]);
  }

  let substitutes = 0;
  for (const group of byCategory.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = cosineSimilarity(group[i]!.embedding, group[j]!.embedding);
        if (sim < SUBSTITUTE_MIN_SIM) continue;
        await upsertGraphEdge({ srcType: "entity", srcId: group[i]!.id, dstType: "entity", dstId: group[j]!.id, relation: "SUBSTITUTE_OF", weight: sim });
        await upsertGraphEdge({ srcType: "entity", srcId: group[j]!.id, dstType: "entity", dstId: group[i]!.id, relation: "SUBSTITUTE_OF", weight: sim });
        substitutes += 2;
      }
    }
  }

  // Arbitrage + bundle markers per entity.
  let arbitrage = 0;
  let bundles = 0;
  for (const e of entities) {
    const stats = await entityPriceStats(e.id);
    if (stats && stats.count >= 2 && stats.maxMinor > 0) {
      const spread = (stats.maxMinor - stats.minMinor) / stats.maxMinor;
      if (spread >= ARBITRAGE_MIN_SPREAD) {
        await upsertGraphEdge({ srcType: "entity", srcId: e.id, dstType: "entity", dstId: e.id, relation: "ARBITRAGE", weight: spread });
        arbitrage++;
      }
    }
    const agg = await entitySupplyAgg(e.id);
    if (agg.sellerCount >= BUNDLE_MIN_SELLERS) {
      await upsertGraphEdge({ srcType: "entity", srcId: e.id, dstType: "entity", dstId: e.id, relation: "BUNDLE_AVAILABLE", weight: agg.sellerCount });
      bundles++;
    }
  }

  const result: GraphEdgeResult = { substitutes, arbitrage, bundles };
  log.info(result, "discovery.graph.edges");
  return result;
}
