import type { WebSearchQuery } from "@opportunity-os/connectors-sdk";

/**
 * Stage-1 broad discovery (AIOOS §4, §21): intent language × opportunity
 * environments. Each run takes a different slice of the pool, so successive
 * runs cast a wide net instead of repeating one search; the source registry
 * and outcomes then show where signal actually is (§32).
 */
export interface StageOneQuery extends WebSearchQuery {
  orientation: "demand" | "supply" | "problem";
  /** The registry source this query belongs to, for its run record and yield. */
  sourceId?: string;
}

/**
 * The pool comes from the source registry (migration 0025, ADR-037): every
 * active search venue that passes its permission policy contributes
 * `site:<domain> <topic>` queries. The built-in venues that used to live here
 * are registry rows with origin `builtin`; they are reviewed, paused and
 * measured like any other source.
 *
 * Rules learned from live runs that the registry's topics keep: host-level
 * `site:` filters only (path filters aren't documented for the search
 * provider), at most one quoted phrase, month windows. A venue is reached only
 * through the search provider's index (snippets); no site is fetched.
 */

/** A registry row as the pool needs it. */
export interface PoolSource {
  id: string;
  domain: string;
  orientation: string;
  topics: string[];
}

/**
 * The full pool, in a stable order, each query tagged with the source it
 * came from. A query two sources would both produce is kept once.
 */
export function poolFromSources(sources: PoolSource[]): StageOneQuery[] {
  const pool: StageOneQuery[] = [];
  const seen = new Set<string>();
  const ordered = [...sources].sort((a, b) => a.domain.localeCompare(b.domain) || a.orientation.localeCompare(b.orientation) || a.id.localeCompare(b.id));
  for (const s of ordered) {
    if (s.orientation !== "demand" && s.orientation !== "supply" && s.orientation !== "problem") continue;
    for (const topic of s.topics) {
      const query = `site:${s.domain} ${topic}`;
      if (seen.has(query)) continue;
      seen.add(query);
      pool.push({ query, orientation: s.orientation, freshness: "month", sourceId: s.id });
    }
  }
  return pool;
}

/**
 * `count` queries for run number `runIndex`, interleaving demand / supply /
 * problem so every run samples all three orientations, and rotating through
 * the pool across runs.
 */
export function stageOneQueries(runIndex: number, count: number, pool: StageOneQuery[]): StageOneQuery[] {
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
