import type { WebSearchQuery } from "@opportunity-os/connectors-sdk";

/**
 * Stage-1 broad discovery (AIOOS §4, §21): intent language × opportunity
 * environments. Each run takes a different slice of the pool, so successive
 * runs cast a wide net instead of repeating one search; the source registry
 * and outcomes then show where signal actually is (§32).
 */
export interface StageOneQuery extends WebSearchQuery {
  orientation: "demand" | "supply" | "problem";
}

/**
 * Where intent actually gets written down. The first live runs (2026-10-03)
 * showed open-web results are mostly articles, product pages and directories,
 * so each query is pinned to a community, procurement or surplus venue.
 * Rules learned from those runs: at most one quoted phrase, month windows.
 * Venues are reached only through the search provider's index (snippets) —
 * no site is fetched or scraped.
 */
interface Venue {
  site: string;
  orientation: StageOneQuery["orientation"];
  /** Topics searched within this venue. */
  topics: string[];
}

// Host-level site: filters only — path filters (site:reddit.com/r/x) aren't
// documented for the search provider and could silently return nothing.
//
// Category-agnostic since 2026-10-16: the user brokers any product or
// service, so venues are chosen for where buyers and sellers of anything
// post, and topics use intent language rather than one industry. (From
// 2026-10-06 the pool searched only for buyers of the user's own web
// services; 13 days of that produced 1 actionable lead.) Earlier pruning
// still holds: sam.gov (unwinnable federal notices), liquidation.com (no
// results), govdeals.com (product pages). New venues are unproven; prune by
// the per-query yield table on the Action Queue and /yield.
const VENUES: Venue[] = [
  // Buyers of goods: open buying requests on B2B trade boards and communities.
  { site: "tradekey.com", orientation: "demand", topics: ["buy offers", "buying request bulk"] },
  { site: "go4worldbusiness.com", orientation: "demand", topics: ["buying leads"] },
  { site: "ec21.com", orientation: "demand", topics: ["buy offers"] },
  { site: "reddit.com", orientation: "demand", topics: ["WTB bulk wholesale", "looking for a supplier", "looking for a manufacturer", "where can I buy in bulk", "need a vendor for my business"] },
  // Buyers of services: people hiring for sourcing, procurement or any outsourced work.
  { site: "upwork.com", orientation: "demand", topics: ["product sourcing agent job", "find suppliers job", "procurement specialist job"] },
  // Sellers: surplus, liquidation, overstock, used equipment and spare capacity.
  { site: "reddit.com", orientation: "supply", topics: ["surplus inventory for sale", "liquidating inventory", "excess stock wholesale lot", "closeout pallets for sale"] },
  { site: "surplusrecord.com", orientation: "supply", topics: ["surplus equipment"] },
  { site: "machinio.com", orientation: "supply", topics: ["used equipment for sale"] },
  // Problems any provider (or the user's own services) could fix, at a business that would pay.
  { site: "reddit.com", orientation: "problem", topics: ["small business need help finding a company", "need a contractor urgently", "recommend a vendor for my business"] },
  { site: "community.shopify.com", orientation: "problem", topics: ["need someone to fix"] },
];

/** Sites the built-in venue list already searches. */
export function builtinSites(): Set<string> {
  return new Set(VENUES.map((v) => v.site));
}

/**
 * The full pool, in a stable order: the built-in venues, then `extra` —
 * queries from sources added at runtime (see sources.ts). A query already in
 * the pool is not added twice.
 */
export function stageOnePool(extra: StageOneQuery[] = []): StageOneQuery[] {
  const pool: StageOneQuery[] = [];
  for (const v of VENUES) {
    for (const topic of v.topics) pool.push({ query: `site:${v.site} ${topic}`, orientation: v.orientation, freshness: "month" });
  }
  const seen = new Set(pool.map((q) => q.query));
  for (const q of extra) {
    if (seen.has(q.query)) continue;
    seen.add(q.query);
    pool.push(q);
  }
  return pool;
}

/**
 * `count` queries for run number `runIndex`, interleaving demand / supply /
 * problem so every run samples all three orientations, and rotating through
 * the pool across runs.
 */
export function stageOneQueries(runIndex: number, count: number, extra: StageOneQuery[] = []): StageOneQuery[] {
  const pool = stageOnePool(extra);
  const total = Math.min(count, pool.length);
  const lanes = (["demand", "problem", "supply"] as const).map((k) => pool.filter((q) => q.orientation === k));
  // How many picks each lane gets per run (interleaved, skipping empty lanes)…
  const picks = lanes.map(() => 0);
  for (let i = 0, assigned = 0; assigned < total; i++) {
    const li = i % lanes.length;
    if (picks[li]! < lanes[li]!.length) {
      picks[li]!++;
      assigned++;
    }
  }
  // …and each lane advances by exactly that many per run, so it cycles through
  // all of its queries regardless of how its size relates to `count`.
  const perLane = lanes.map((lane, li) => Array.from({ length: picks[li]! }, (_, j) => lane[(runIndex * picks[li]! + j) % lane.length]!));
  const out: StageOneQuery[] = [];
  for (let j = 0; out.length < total; j++) {
    for (const laneQueries of perLane) if (j < laneQueries.length && out.length < total) out.push(laneQueries[j]!);
  }
  return out;
}
