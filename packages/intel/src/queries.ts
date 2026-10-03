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

const DEMAND_INTENT = ['"WTB"', '"looking for"', '"request for quote"', '"sources sought"', '"can\'t find"', '"need asap"', '"supplier needed"', '"ISO"'];
const DEMAND_GOODS = [
  "forklift",
  "pallet racking",
  "used restaurant equipment",
  "industrial generator",
  "CNC machine",
  "shipping container",
  "bulk packaging supplier",
  "obsolete electronic components",
  "commercial refrigeration",
  "heavy equipment parts",
  "office furniture bulk",
  "printing services",
];

const SUPPLY_INTENT = ['"liquidation"', '"warehouse closing"', '"surplus inventory"', '"overstock"', '"must sell"', '"excess inventory"'];
const SUPPLY_GOODS = ["restaurant equipment", "industrial machinery", "electronics pallets", "office furniture", "retail fixtures", "building materials"];

// One quoted phrase at most: stacking exact phrases under a recency window
// returned nothing in the first live run (2026-10-03).
const PROBLEM_QUERIES = [
  'GA4 "not tracking" conversions help',
  'Google Tag Manager tags not firing help',
  'WordPress site hacked need help small business',
  'Divi theme "broken after update"',
  'WooCommerce "checkout not working"',
  'WordPress contact form "not sending" emails',
  'Facebook pixel "not tracking" purchases',
  '"website down" losing customers',
  '"leads dropped" website help',
  'project stalled need project manager small business',
];

/** The full pool, in a stable order. */
export function stageOnePool(): StageOneQuery[] {
  const pool: StageOneQuery[] = [];
  DEMAND_GOODS.forEach((goods, i) => {
    pool.push({ query: `${DEMAND_INTENT[i % DEMAND_INTENT.length]} ${goods}`, orientation: "demand", freshness: "week" });
  });
  SUPPLY_GOODS.forEach((goods, i) => {
    pool.push({ query: `${SUPPLY_INTENT[i % SUPPLY_INTENT.length]} ${goods}`, orientation: "supply", freshness: "month" });
  });
  for (const q of PROBLEM_QUERIES) pool.push({ query: q, orientation: "problem", freshness: "month" });
  return pool;
}

/**
 * `count` queries for run number `runIndex`, interleaving demand / supply /
 * problem so every run samples all three orientations, and rotating through
 * the pool across runs.
 */
export function stageOneQueries(runIndex: number, count: number): StageOneQuery[] {
  const pool = stageOnePool();
  const byKind = (k: StageOneQuery["orientation"]) => pool.filter((q) => q.orientation === k);
  const lanes = [byKind("demand"), byKind("problem"), byKind("supply")];
  const out: StageOneQuery[] = [];
  for (let i = 0; out.length < Math.min(count, pool.length); i++) {
    const lane = lanes[i % lanes.length]!;
    const pick = lane[(runIndex * count + Math.floor(i / lanes.length)) % lane.length]!;
    if (!out.some((q) => q.query === pick.query)) out.push(pick);
    if (i > count * 10) break;
  }
  return out;
}
