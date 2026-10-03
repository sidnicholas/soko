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
// Host-level site: filters only — path filters (site:reddit.com/r/x) aren't
// documented for the search provider and could silently return nothing.
// Exact phrases are avoided on reddit/liquidation: in the 18:00 UTC run on
// 2026-10-03 every quoted query there returned zero results.
const VENUES: Venue[] = [
  // Demand: people and organizations asking for a supplier or item.
  { site: "reddit.com", orientation: "demand", topics: ["small business looking for supplier", "need a vendor for my business", "looking for manufacturer for my product", "restaurant looking for used equipment", "hiring sourcing research help"] },
  { site: "sam.gov", orientation: "demand", topics: ['"sources sought" equipment', '"request for quote" supplies', '"sources sought" services'] },
  // Supply: surplus, liquidation and distressed inventory venues.
  { site: "govdeals.com", orientation: "supply", topics: ["forklift", "restaurant equipment", "generator"] },
  { site: "liquidation.com", orientation: "supply", topics: ["electronics pallets", "overstock lots"] },
  { site: "reddit.com", orientation: "supply", topics: ["closing my business selling inventory", "liquidating business equipment"] },
  // Problems: owners describing costly website / tracking / ops failures.
  // wordpress.org returned plugin pages, not support threads — WordPress problems go via reddit.
  { site: "reddit.com", orientation: "problem", topics: ["GA4 conversions not tracking", "GA4 purchases missing shopify", "Google Tag Manager tags not firing", "WordPress site hacked my business", "WordPress contact form not sending emails", "WooCommerce checkout not working", "Shopify pixel not tracking purchases", "Google Ads conversions not recording", "website down losing customers help", "Divi site broken after update"] },
  { site: "community.shopify.com", orientation: "problem", topics: ["checkout broken", "tracking not working"] },
];

/** The full pool, in a stable order. */
export function stageOnePool(): StageOneQuery[] {
  const pool: StageOneQuery[] = [];
  for (const v of VENUES) {
    for (const topic of v.topics) pool.push({ query: `site:${v.site} ${topic}`, orientation: v.orientation, freshness: "month" });
  }
  return pool;
}

/**
 * `count` queries for run number `runIndex`, interleaving demand / supply /
 * problem so every run samples all three orientations, and rotating through
 * the pool across runs.
 */
export function stageOneQueries(runIndex: number, count: number): StageOneQuery[] {
  const pool = stageOnePool();
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
