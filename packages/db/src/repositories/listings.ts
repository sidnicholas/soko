import { sql } from "kysely";
import { getDb } from "../pool";

/**
 * Marketplace view: every demand and supply record the system holds, listed
 * on its own whether or not it was ever paired. Two origins feed it — the
 * AIOOS web-intelligence leads (`intel_leads`) and the mission/connector
 * pipeline (`demands`, `supply`) — because only matched pairs surface as
 * opportunities or queue candidates, and an unmatched side is exactly what an
 * operator with off-network counterparties can use.
 */
export type ListingSide = "demand" | "supply";
export type ListingOrigin = "intel" | "marketplace";

export interface MarketListing {
  /** `<origin>:<row id>` — ids from the three tables can't collide. */
  id: string;
  side: ListingSide;
  origin: ListingOrigin;
  /** `problem` is an intel lead describing a failure someone needs fixed; it lists on the demand side. */
  type: "demand" | "supply" | "problem";
  title: string;
  description: string;
  category: string | null;
  /** Asking price (supply) or budget (demand), integer minor units. */
  price_minor: number | null;
  currency: string | null;
  quantity: string | null;
  location: string | null;
  needed_by: string | null;
  /** Hostname for intel leads; connector or channel id for marketplace rows. */
  source: string;
  url: string | null;
  contact: unknown;
  /** True once the system has paired this record with an opposite side. */
  matched: boolean;
  /** Short machine-readable reason behind `matched` (bucket, reject reason, or match counts). */
  match_detail: string;
  /** Record state at its origin: intel lead status, or marketplace availability. */
  status: string;
  created_at: string;
}

const DEFAULT_LIMIT_PER_SOURCE = 500;

function minorFromMoney(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const amount = (value as { amount?: unknown }).amount;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

async function intelListings(limit: number): Promise<MarketListing[]> {
  const result = await sql<{
    id: string;
    kind: "demand" | "supply" | "problem";
    title: string;
    summary: string;
    category: string | null;
    price_minor: number | null;
    currency: string | null;
    quantity: string | null;
    location: string | null;
    deadline: string | null;
    hostname: string;
    url: string;
    contact: unknown;
    status: string;
    created_at: string;
    paired: number;
    best_bucket: string | null;
    reject_reason: string | null;
  }>`
    select l.id, l.kind, l.title, l.summary, l.category, l.price_minor, l.currency, l.quantity, l.location,
           l.deadline, l.hostname, l.url, l.contact, l.status, l.discovered_at::text as created_at,
           coalesce(c.paired, 0)::int as paired, c.best_bucket, c.reject_reason
    from intel_leads l
    left join lateral (
      -- A candidate row exists for every assessed lead; it only counts as a
      -- pairing when an opposite side (a counter page or one of the user's
      -- services) was actually found and the candidate was not rejected.
      select count(*) filter (where bucket <> 'rejected' and (counter_url is not null or service_key is not null)) as paired,
             (array_agg(bucket order by score desc) filter (where bucket <> 'rejected'))[1] as best_bucket,
             (array_agg(reject_reason order by created_at desc) filter (where reject_reason is not null))[1] as reject_reason
      from intel_candidates
      where lead_id = l.id
    ) c on true
    order by l.discovered_at desc
    limit ${limit}
  `.execute(getDb());

  return result.rows.map((r) => {
    const matched = r.paired > 0;
    return {
      id: `intel:${r.id}`,
      side: r.kind === "supply" ? "supply" : "demand",
      origin: "intel",
      type: r.kind,
      title: r.title,
      description: r.summary,
      category: r.category,
      price_minor: r.price_minor,
      currency: r.currency,
      quantity: r.quantity,
      location: r.location,
      needed_by: r.deadline,
      source: r.hostname,
      url: r.url,
      contact: r.contact ?? null,
      matched,
      match_detail: matched ? (r.best_bucket ?? "paired") : (r.reject_reason ?? (r.status === "new" ? "not_assessed" : r.status)),
      status: r.status,
      created_at: r.created_at,
    };
  });
}

function matchDetail(matches: number, opportunities: number): string {
  if (matches === 0) return "no_match";
  return `${matches} match${matches === 1 ? "" : "es"}, ${opportunities} live opportunit${opportunities === 1 ? "y" : "ies"}`;
}

async function supplyListings(limit: number): Promise<MarketListing[]> {
  const result = await sql<{
    id: string;
    source_id: string;
    title: string;
    description: string;
    category: string | null;
    price: unknown;
    currency: string;
    quantity: number | null;
    location: string | null;
    availability_status: string;
    created_at: string;
    matches: number;
    opportunities: number;
  }>`
    select s.id, s.source_id, s.title, s.description, s.category, s.price, s.currency, s.quantity,
           coalesce(s.location->>'label', s.location->>'city', s.location->>'region') as location,
           s.availability_status, s.created_at::text as created_at,
           coalesce(m.matches, 0)::int as matches, coalesce(m.opportunities, 0)::int as opportunities
    from supply s
    left join lateral (
      select count(distinct mt.id) as matches,
             count(distinct o.id) filter (where o.status not in ('rejected', 'expired')) as opportunities
      from matches mt
      left join opportunities o on o.match_id = mt.id
      where mt.supply_id = s.id
    ) m on true
    order by s.created_at desc
    limit ${limit}
  `.execute(getDb());

  return result.rows.map((r) => ({
    id: `marketplace:${r.id}`,
    side: "supply",
    origin: "marketplace",
    type: "supply",
    title: r.title,
    description: r.description,
    category: r.category,
    price_minor: minorFromMoney(r.price),
    currency: r.currency,
    quantity: r.quantity === null ? null : String(r.quantity),
    location: r.location,
    needed_by: null,
    source: r.source_id,
    url: null,
    contact: null,
    matched: r.matches > 0,
    match_detail: matchDetail(r.matches, r.opportunities),
    status: r.availability_status,
    created_at: r.created_at,
  }));
}

async function demandListings(limit: number): Promise<MarketListing[]> {
  const result = await sql<{
    id: string;
    source_id: string;
    mission_title: string | null;
    description: string;
    category: string | null;
    target_price: unknown;
    max_budget: unknown;
    currency: string;
    location: string | null;
    needed_by: string | null;
    availability_status: string;
    created_at: string;
    matches: number;
    opportunities: number;
  }>`
    select d.id, d.source_id, ms.title as mission_title, d.description, d.category, d.target_price, d.max_budget, d.currency,
           coalesce(d.fulfillment_location->>'label', d.fulfillment_location->>'city', d.fulfillment_location->>'region') as location,
           d.needed_by::text as needed_by, d.availability_status, d.created_at::text as created_at,
           coalesce(m.matches, 0)::int as matches, coalesce(m.opportunities, 0)::int as opportunities
    from demands d
    left join missions ms on ms.id = d.mission_id
    left join lateral (
      select count(distinct mt.id) as matches,
             count(distinct o.id) filter (where o.status not in ('rejected', 'expired')) as opportunities
      from matches mt
      left join opportunities o on o.match_id = mt.id
      where mt.demand_id = d.id
    ) m on true
    order by d.created_at desc
    limit ${limit}
  `.execute(getDb());

  return result.rows.map((r) => ({
    id: `marketplace:${r.id}`,
    side: "demand",
    origin: "marketplace",
    type: "demand",
    title: r.mission_title ?? r.description.slice(0, 120),
    description: r.description,
    category: r.category,
    price_minor: minorFromMoney(r.max_budget) ?? minorFromMoney(r.target_price),
    currency: r.currency,
    quantity: null,
    location: r.location,
    needed_by: r.needed_by,
    source: r.source_id,
    url: null,
    contact: null,
    matched: r.matches > 0,
    match_detail: matchDetail(r.matches, r.opportunities),
    status: r.availability_status,
    created_at: r.created_at,
  }));
}

/**
 * All demand and supply records, newest first, capped per source table.
 * Includes every user's mission demands, so callers must hold a staff
 * permission (the same read-all standing as `missions/mission-access.ts`).
 */
export async function listMarketListings(limitPerSource = DEFAULT_LIMIT_PER_SOURCE): Promise<MarketListing[]> {
  const [intel, supply, demands] = await Promise.all([intelListings(limitPerSource), supplyListings(limitPerSource), demandListings(limitPerSource)]);
  return [...intel, ...supply, ...demands].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
