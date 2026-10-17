import { sql } from "kysely";
import { getDb } from "../pool";

/**
 * Good-deal checks (migration 0034, ADR-044): which new actor listings have
 * been priced against the market, and the verdict and evidence for each.
 */

export interface UncheckedListing {
  observation_id: string;
  source_id: string;
  supply_id: string;
  title: string;
  description: string;
  category: string | null;
  price: unknown;
  currency: string;
  listing_url: string | null;
  location: unknown;
  first_seen_at: string;
}

/** New supply listings from actor sources not yet checked, newest first (last `days` days). */
export async function listUncheckedListings(limit: number, days = 7): Promise<UncheckedListing[]> {
  if (limit <= 0) return [];
  const rows = await getDb()
    .selectFrom("source_observations as o")
    .innerJoin("source_registry as s", "s.id", "o.source_id")
    .innerJoin("supply as p", "p.id", "o.supply_id")
    .leftJoin("deal_checks as d", "d.observation_id", "o.id")
    .select(["o.id as observation_id", "o.source_id", "p.id as supply_id", "p.title", "p.description", "p.category", "p.price", "p.currency", "p.listing_url", "p.location", sql<string>`o.first_seen_at::text`.as("first_seen_at")])
    .where("s.kind", "=", "apify_actor")
    .where("o.kind", "=", "supply")
    .where("o.merged", "=", false)
    .where("d.id", "is", null)
    .where(sql<boolean>`o.first_seen_at >= now() - make_interval(days => ${days})`)
    .orderBy("o.first_seen_at", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as UncheckedListing[];
}

export type DealVerdict = "good_deal" | "fair" | "overpriced" | "no_comps" | "no_price";

export async function recordDealCheck(c: {
  observationId: string;
  sourceId: string;
  supplyId: string;
  query: string | null;
  priceMinor: number | null;
  currency: string | null;
  comps: { title: string; url: string | null; priceMinor: number }[];
  compMedianMinor: number | null;
  discount: number | null;
  demandTerm: string | null;
  verdict: DealVerdict;
  leadId: string | null;
}): Promise<void> {
  await getDb()
    .insertInto("deal_checks")
    .values({
      observation_id: c.observationId,
      source_id: c.sourceId,
      supply_id: c.supplyId,
      query: c.query,
      price_minor: c.priceMinor,
      currency: c.currency,
      comps: c.comps.length,
      comp_median_minor: c.compMedianMinor,
      discount: c.discount === null ? null : c.discount.toFixed(4),
      demand_term: c.demandTerm,
      verdict: c.verdict,
      comps_json: JSON.stringify(c.comps.slice(0, 10)),
      lead_id: c.leadId,
    })
    .onConflict((oc) => oc.column("observation_id").doNothing())
    .execute();
}

/** Verdict counts per source over the last `days` days. */
export async function dealCheckSummary(sourceId: string, days = 7): Promise<Record<DealVerdict, number> & { leads: number }> {
  const rows = await getDb()
    .selectFrom("deal_checks")
    .select(["verdict", sql<number>`count(*)::int`.as("n"), sql<number>`count(lead_id)::int`.as("leads")])
    .where("source_id", "=", sourceId)
    .where(sql<boolean>`checked_at >= now() - make_interval(days => ${days})`)
    .groupBy("verdict")
    .execute();
  const out = { good_deal: 0, fair: 0, overpriced: 0, no_comps: 0, no_price: 0, leads: 0 } as Record<DealVerdict, number> & { leads: number };
  for (const r of rows) {
    out[r.verdict as DealVerdict] = r.n;
    out.leads += r.leads;
  }
  return out;
}

export interface UnraisedDemand {
  observation_id: string;
  source_id: string;
  source_name: string;
  external_id: string;
  content: unknown;
  first_seen_at: string;
}

/** Buyer items from actor sources not yet considered for a demand lead, newest first (last `days` days). */
export async function listUnraisedDemand(limit: number, days = 14): Promise<UnraisedDemand[]> {
  if (limit <= 0) return [];
  const rows = await getDb()
    .selectFrom("source_observations as o")
    .innerJoin("source_registry as s", "s.id", "o.source_id")
    .select(["o.id as observation_id", "o.source_id", "s.name as source_name", "o.external_id", "o.content", sql<string>`o.first_seen_at::text`.as("first_seen_at")])
    .where("s.kind", "=", "apify_actor")
    .where("o.kind", "=", "demand")
    .where("o.lead_checked_at", "is", null)
    .where(sql<boolean>`o.first_seen_at >= now() - make_interval(days => ${days})`)
    .orderBy("o.first_seen_at", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as UnraisedDemand[];
}

export async function markDemandConsidered(observationId: string, leadId: string | null): Promise<void> {
  await getDb().updateTable("source_observations").set({ lead_id: leadId, lead_checked_at: new Date().toISOString() }).where("id", "=", observationId).execute();
}
