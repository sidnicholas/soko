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
// Pruned 2026-10-06 from 15 runs of yield data: sam.gov (every lead an
// unwinnable federal notice), liquidation.com (zero results every run),
// govdeals.com (product pages), and reddit queries that returned only
// articles/news over 3+ runs. Kept the queries that produced leads, and added
// venues where buyers ask to hire for the user's own services.
const VENUES: Venue[] = [
  // Demand for the user's services: people hiring for work the catalog covers.
  { site: "upwork.com", orientation: "demand", topics: ["GA4 tracking fix job", "Google Tag Manager setup job", "Shopify conversion tracking job", "WordPress site fix urgent job"] },
  { site: "reddit.com", orientation: "demand", topics: ["[hiring] GA4 tracking", "hiring shopify developer tracking fix", "small business looking for supplier", "need a vendor for my business", "hiring sourcing research help"] },
  // B2B buying requests (demand for goods; the why-paid test decides if a sourcing fee is realistic).
  { site: "tradekey.com", orientation: "demand", topics: ["buy offers packaging", "buy offers equipment"] },
  // Problems: owners describing costly website / tracking failures.
  { site: "reddit.com", orientation: "problem", topics: ["GA4 purchases missing shopify", "website down losing customers help"] },
  { site: "community.shopify.com", orientation: "problem", topics: ["checkout broken", "tracking not working", "need someone to fix"] },
  { site: "support.google.com", orientation: "problem", topics: ["GA4 purchases not showing", "conversions not recording analytics"] },
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
