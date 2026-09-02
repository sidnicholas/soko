import {
  listAvailableSupply,
  listOpenDemands,
  upsertEntity,
  linkEntityMember,
  recordPriceObservation,
  upsertGraphEdge,
  listEntityMembers,
} from "@opportunity-os/db";
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
    touched.add(entityId);
    await linkEntityMember(entityId, "demand", d.id);
    membersLinked++;
  }

  const result: ResolveEntitiesResult = { entitiesTouched: touched.size, membersLinked, priceObservations, comparableEdges };
  log.info(result, "discovery.entities.resolved");
  return result;
}
