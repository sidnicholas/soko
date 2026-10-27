import { createHash } from "node:crypto";
import { insertIntelLead, listUncheckedListings, recentDemandTerms, recordDealCheck, type DealVerdict, type UncheckedListing } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";

/**
 * Good-deal filter (ADR-044). A new actor listing is priced against comparable
 * listings (eBay, through the official Browse API): only one priced well under
 * the comparables' median becomes a supply lead, which the intel pipeline then
 * takes through the buyer search, delivered-cost economics and scoring before
 * anything reaches the Action Queue. A listing with too few comparables is
 * not guessed at: it stays in the supply pool, out of the queue.
 *
 * Comparables are asking prices of active listings, so the discount is a
 * screen, not a valuation; the assessment that follows decides.
 */

const log = createLogger("intel:deals");

export interface Comparable {
  title: string;
  url: string | null;
  priceMinor: number;
  currency: string;
}

/** Comparable listings for a search; injected (eBay in production, a stub in tests). */
export type CompsProvider = (query: string) => Promise<Comparable[]>;

/** Fewer comparables than this and the median means little. */
export const MIN_COMPS = 5;
export const DEFAULT_MIN_DISCOUNT = 0.3;

const STOP = new Set(
  "a an and the for of with in on to new used like great good excellent condition works working must sell sale selling obo firm price cash pickup pick up only asap brand nice clean set lot each wanted wtb iso looking need needed buying buy want seeking urgent".split(" "),
);

/** A comparables search from a listing title: its first meaningful words, no noise. */
export function compsQuery(title: string): string | null {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/**
 * The verdict on one price against its comparables: the median of those in
 * the same currency, after dropping the cheapest and dearest tenth (parts,
 * bundles, typos). A recent buyer request lowers the bar by half.
 */
/** Lowest discount stored; any lower is just as overpriced. */
export const DISCOUNT_FLOOR = -99.9999;

export function judgeDeal(priceMinor: number | null, currency: string, comps: Comparable[], opts: { minDiscount: number; demandMatch: boolean }): { verdict: DealVerdict; medianMinor: number | null; discount: number | null; used: Comparable[] } {
  if (priceMinor === null || priceMinor <= 0) return { verdict: "no_price", medianMinor: null, discount: null, used: [] };
  const same = comps.filter((c) => c.currency === currency && c.priceMinor > 0).sort((a, b) => a.priceMinor - b.priceMinor);
  // A tenth off each end (at least one of each from 8 up), as long as enough remain.
  const cut = Math.round(same.length / 10);
  const trim = same.length - 2 * cut >= MIN_COMPS ? cut : 0;
  const used = same.slice(trim, same.length - trim);
  if (used.length < MIN_COMPS) return { verdict: "no_comps", medianMinor: null, discount: null, used };
  const medianMinor = median(used.map((c) => c.priceMinor))!;
  // Floored at -99.9999: deal_checks.discount is numeric(6, 4), and a listing
  // priced over ~100x its comparables (usually a search that matched the wrong
  // kind of item) would otherwise fail the insert on every sweep.
  const discount = Math.max(DISCOUNT_FLOOR, Math.round((1 - priceMinor / medianMinor) * 10_000) / 10_000);
  const bar = opts.demandMatch ? opts.minDiscount / 2 : opts.minDiscount;
  return { verdict: discount >= bar ? "good_deal" : discount >= 0 ? "fair" : "overpriced", medianMinor, discount, used };
}

const usd = (minor: number, currency: string) => `${currency === "USD" ? "$" : `${currency} `}${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const priceOf = (p: unknown): { amount: number; currency: string } | null => {
  const v = p as { amount?: unknown; currency?: unknown } | null;
  return v && typeof v.amount === "number" ? { amount: v.amount, currency: typeof v.currency === "string" ? v.currency : "USD" } : null;
};
const locationOf = (l: unknown): string | null => {
  const v = l as { label?: unknown } | null;
  return v && typeof v.label === "string" ? v.label : null;
};

/** The buyer searches the counterpart stage runs for an underpriced listing. */
export function buyerQueries(query: string): string[] {
  return [`wanted ${query}`, `buying ${query} in bulk`];
}

export interface DealCheckSummary {
  checked: number;
  goodDeals: number;
  leads: number;
  verdicts: Record<DealVerdict, number>;
}

/**
 * Checks new actor listings (newest first, at most `limit`) and turns the
 * good deals into supply leads (at most `leadLimit`; the rest of the good deals
 * are recorded and can be raised later). Listings a recent buyer asked for go
 * first.
 */
export async function checkDeals(opts: { comps: CompsProvider; limit: number; leadLimit: number; minDiscount?: number }): Promise<DealCheckSummary> {
  const minDiscount = opts.minDiscount ?? DEFAULT_MIN_DISCOUNT;
  const listings = await listUncheckedListings(opts.limit);
  const demand = [...new Set((await recentDemandTerms(7, 100)).map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3))];
  const demandFor = (l: UncheckedListing) => demand.find((t) => `${l.title} ${l.description}`.toLowerCase().includes(t)) ?? null;
  // Demand matches first, so the lead limit goes to them.
  const ordered = [...listings].sort((a, b) => Number(!!demandFor(b)) - Number(!!demandFor(a)));
  const summary: DealCheckSummary = { checked: 0, goodDeals: 0, leads: 0, verdicts: { good_deal: 0, fair: 0, overpriced: 0, no_comps: 0, no_price: 0 } };

  for (const l of ordered) {
    const price = priceOf(l.price);
    const query = compsQuery(l.title);
    const demandTerm = demandFor(l);
    let comps: Comparable[] = [];
    if (price && query) {
      try {
        comps = await opts.comps(query);
      } catch (err) {
        // Comparables unavailable (rate limit, outage): leave it unchecked for the next sweep.
        log.warn({ query, err: String(err) }, "deals.comps_failed");
        break;
      }
    }
    const j = query ? judgeDeal(price?.amount ?? null, price?.currency ?? l.currency, comps, { minDiscount, demandMatch: !!demandTerm }) : { verdict: (price ? "no_comps" : "no_price") as DealVerdict, medianMinor: null, discount: null, used: [] };
    let leadId: string | null = null;
    if (j.verdict === "good_deal" && summary.leads < opts.leadLimit && l.listing_url && price && query) {
      const url = l.listing_url;
      const location = locationOf(l.location);
      const pct = Math.round(j.discount! * 100);
      leadId = await insertIntelLead({
        runId: null,
        kind: "supply",
        title: l.title,
        summary: `Listed at ${usd(price.amount, price.currency)}, about ${pct}% under the median of ${j.used.length} comparable eBay listings (${usd(j.medianMinor!, price.currency)})${location ? `, in ${location}` : ""}.${demandTerm ? ` A recent buyer asked for "${demandTerm}".` : ""}`,
        url,
        urlHash: createHash("sha256").update(url).digest("hex"),
        hostname: new URL(url).hostname.replace(/^www\./, ""),
        query: `deal-check:${query}`,
        searchProvider: "apify",
        publishedAt: l.first_seen_at,
        ageText: null,
        item: query,
        category: l.category,
        quantity: null,
        location,
        deadline: null,
        priceMinor: price.amount,
        currency: price.currency,
        urgency: demandTerm ? "high" : "medium",
        // Ranks the assessment pool: deeper discounts and buyer matches first.
        credibility: Math.min(0.95, 0.55 + j.discount! * 0.5 + (demandTerm ? 0.1 : 0)),
        contact: { channel: "marketplace_message", value: null, label: "source_fact" },
        facts: [
          { field: "listed_price", value: usd(price.amount, price.currency), label: "source_fact" },
          { field: "comparable_median", value: `${usd(j.medianMinor!, price.currency)} across ${j.used.length} active eBay listings for "${query}"`, label: "estimate" },
          { field: "discount_to_comparables", value: `${pct}%`, label: "estimate" },
          ...(demandTerm ? [{ field: "matching_buyer_request", value: demandTerm, label: "source_fact" }] : []),
        ],
        oppositeQueries: buyerQueries(query),
        signalType: "listed_stock",
        evidenceLevel: "observed",
      });
      if (leadId) summary.leads++;
    }
    await recordDealCheck({
      observationId: l.observation_id,
      sourceId: l.source_id,
      supplyId: l.supply_id,
      query,
      priceMinor: price?.amount ?? null,
      currency: price?.currency ?? l.currency,
      comps: j.used.map((c) => ({ title: c.title, url: c.url, priceMinor: c.priceMinor })),
      compMedianMinor: j.medianMinor,
      discount: j.discount,
      demandTerm,
      verdict: j.verdict,
      leadId,
    });
    summary.checked++;
    summary.verdicts[j.verdict]++;
    if (j.verdict === "good_deal") summary.goodDeals++;
  }
  if (summary.checked) log.info(summary, "deals.checked");
  return summary;
}
