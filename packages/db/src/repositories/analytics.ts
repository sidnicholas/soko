import { sql } from "kysely";
import { getDb } from "../pool";

/** One UTC day of intel spend and yield. */
export interface IntelDay {
  day: string;
  runs: number;
  searchUsd: number;
  llmUsd: number;
  leads: number;
  candidates: number;
  actionable: number;
  costPerActionableUsd: number | null;
}

/** Leads and outcomes by the search provider that found them (Brave vs Serper, PRD v2 P0 baseline). */
export interface ProviderYield {
  provider: string;
  leads: number;
  actionable: number;
  contacted: number;
  won: number;
  realizedUsd: number;
}

/** Opportunity counts by kind and status, the mission/graph side of the funnel. */
export interface OpportunityFunnelRow {
  kind: string;
  status: string;
  count: number;
}

/**
 * Baseline funnel and spend (PRD v2 P0: instrument before optimizing). Intel
 * spend and yield per UTC day, yield per search provider, and the opportunity
 * pipeline by kind and status. Read-only; nothing here is cached.
 */
export async function yieldReport(days: number): Promise<{ days: number; intelByDay: IntelDay[]; intelByProvider: ProviderYield[]; opportunityFunnel: OpportunityFunnelRow[] }> {
  const db = getDb();
  const since = sql`now() - make_interval(days => ${days})`;

  const runs = await db
    .selectFrom("intel_runs")
    .select([
      sql<string>`(started_at at time zone 'utc')::date::text`.as("day"),
      sql<number>`count(*)::int`.as("runs"),
      sql<string>`coalesce(sum(search_usd), 0)`.as("search_usd"),
      sql<string>`coalesce(sum(llm_usd), 0)`.as("llm_usd"),
      sql<number>`coalesce(sum(leads_found), 0)::int`.as("leads"),
      sql<number>`coalesce(sum(candidates), 0)::int`.as("candidates"),
    ])
    .where(sql<boolean>`started_at >= ${since}`)
    .groupBy(sql`1`)
    .execute();
  const actionable = await db
    .selectFrom("intel_candidates")
    .select([sql<string>`(created_at at time zone 'utc')::date::text`.as("day"), sql<number>`count(*)::int`.as("n")])
    .where("bucket", "in", ["act_now", "verify_next"])
    .where(sql<boolean>`created_at >= ${since}`)
    .groupBy(sql`1`)
    .execute();
  const actionableByDay = new Map(actionable.map((r) => [r.day, r.n]));
  const intelByDay = runs
    .map((r): IntelDay => {
      const spent = Number(r.search_usd) + Number(r.llm_usd);
      const n = actionableByDay.get(r.day) ?? 0;
      return {
        day: r.day,
        runs: r.runs,
        searchUsd: Number(r.search_usd),
        llmUsd: Number(r.llm_usd),
        leads: r.leads,
        candidates: r.candidates,
        actionable: n,
        costPerActionableUsd: n > 0 ? spent / n : null,
      };
    })
    .sort((a, b) => b.day.localeCompare(a.day));

  const providers = await db
    .selectFrom("intel_leads as l")
    .leftJoin("intel_candidates as c", "c.lead_id", "l.id")
    .select([
      "l.search_provider as provider",
      sql<number>`count(distinct l.id)::int`.as("leads"),
      sql<number>`count(distinct l.id) filter (where c.bucket in ('act_now', 'verify_next'))::int`.as("actionable"),
      sql<number>`count(distinct l.id) filter (where c.user_status in ('contacted', 'responded', 'won', 'lost'))::int`.as("contacted"),
      sql<number>`count(distinct l.id) filter (where c.user_status = 'won')::int`.as("won"),
      sql<string>`coalesce(sum(c.realized_usd), 0)`.as("realized_usd"),
    ])
    .where(sql<boolean>`l.discovered_at >= ${since}`)
    .groupBy("l.search_provider")
    .execute();

  const funnel = await db
    .selectFrom("opportunities")
    .select(["kind", "status", sql<number>`count(*)::int`.as("count")])
    .groupBy(["kind", "status"])
    .orderBy("kind")
    .orderBy("status")
    .execute();

  return {
    days,
    intelByDay,
    intelByProvider: providers.map((p) => ({
      provider: p.provider,
      leads: p.leads,
      actionable: p.actionable,
      contacted: p.contacted,
      won: p.won,
      realizedUsd: Number(p.realized_usd),
    })),
    opportunityFunnel: funnel.map((f) => ({ kind: String(f.kind), status: String(f.status), count: f.count })),
  };
}
