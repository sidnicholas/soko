import { getDb } from "../pool";

/**
 * Who is on each side of an opportunity and where they were found. The
 * opportunity row holds only economics and scores; the people and listings
 * behind it live in demands, supply, matches and (for graph deals) entity
 * members. This joins them for the detail page.
 */

/** A buyer or seller as the source describes them. */
export interface OpportunityCounterparty {
  name: string;
  url?: string;
  detail?: string;
}

/** One demand or supply record behind an opportunity. */
export interface OpportunityParty {
  kind: "demand" | "supply";
  id: string;
  title: string;
  summary: string;
  category: string | null;
  /** Asking price (supply) or budget, else target price (demand). Minor units. */
  price: { amount: number; currency: string } | null;
  price_label: "Asking price" | "Budget" | "Target price";
  quantity: number | null;
  /** Connector or channel id the record came from (`ebay`, `reverb`, `mission`, `sms`, …). */
  platform: string;
  external_ref: string | null;
  url: string | null;
  location: string | null;
  counterparty: OpportunityCounterparty | null;
  condition: string | null;
  needed_by: string | null;
  availability: string;
  last_verified_at: string | null;
  created_at: string;
  mission: { id: string; title: string } | null;
  /** Set when the record was resolved from an inbound message. */
  signal: { channel: string; captured_at: string } | null;
}

export interface OpportunitySide {
  role: "buyer" | "seller";
  label: string;
  /** What these records are and are not, when that is not obvious from the label. */
  note: string | null;
  parties: OpportunityParty[];
}

export interface OpportunityMatchDetail {
  scores: { semantic: number; constraint: number; geography: number; timing: number; quality: number; total: number };
  rationale: string | null;
  shared_terms: string[];
  category_aligned: boolean | null;
  within_budget: boolean | null;
}

export interface OpportunityDetails {
  kind: string;
  sides: OpportunitySide[];
  match: OpportunityMatchDetail | null;
}

/** Graph deals list at most this many listings per side, cheapest first. */
const GRAPH_LISTINGS_PER_SIDE = 5;

/** pg returns timestamptz as a Date (no type parser is set); the API sends ISO strings. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return readObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readMoney(value: unknown): { amount: number; currency: string } | null {
  const o = readObject(value);
  if (!o || typeof o["amount"] !== "number") return null;
  return { amount: o["amount"], currency: typeof o["currency"] === "string" ? o["currency"] : "USD" };
}

function readString(o: Record<string, unknown> | null, key: string): string | null {
  const v = o?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function locationLabel(value: unknown): string | null {
  const o = readObject(value);
  return readString(o, "label") ?? ([readString(o, "city"), readString(o, "region")].filter(Boolean).join(", ") || null);
}

function readCounterparty(value: unknown): OpportunityCounterparty | null {
  const o = readObject(value);
  const name = readString(o, "name");
  if (!name) return null;
  const url = readString(o, "url");
  const detail = readString(o, "detail");
  return { name, ...(url ? { url } : {}), ...(detail ? { detail } : {}) };
}

async function signalsFor(kind: "demand" | "supply", ids: string[]) {
  if (ids.length === 0) return new Map<string, { channel: string; captured_at: string }>();
  const rows = await getDb()
    .selectFrom("signals")
    .select(["resolved_entity_id", "channel", "captured_at"])
    .where("resolved_entity_type", "=", kind)
    .where("resolved_entity_id", "in", ids)
    .execute();
  return new Map(rows.map((r) => [r.resolved_entity_id!, { channel: r.channel, captured_at: iso(r.captured_at) }]));
}

async function supplyParties(ids: string[]): Promise<OpportunityParty[]> {
  if (ids.length === 0) return [];
  const [rows, signals] = await Promise.all([
    getDb()
      .selectFrom("supply as s")
      .leftJoin("counterparties as c", "c.id", "s.counterparty_id")
      .select([
        "s.id",
        "s.title",
        "s.description",
        "s.category",
        "s.price",
        "s.quantity",
        "s.source_id",
        "s.external_ref",
        "s.listing_url",
        "s.location",
        "s.seller_json",
        "s.condition_json",
        "s.availability_status",
        "s.last_verified_at",
        "s.created_at",
        "c.normalized_name as counterparty_name",
      ])
      .where("s.id", "in", ids)
      .execute(),
    signalsFor("supply", ids),
  ]);
  return rows.map((r) => ({
    kind: "supply",
    id: r.id,
    title: r.title,
    summary: r.description,
    category: r.category,
    price: readMoney(r.price),
    price_label: "Asking price",
    quantity: r.quantity,
    platform: r.source_id,
    external_ref: r.external_ref,
    url: r.listing_url,
    location: locationLabel(r.location),
    counterparty: readCounterparty(r.seller_json) ?? (r.counterparty_name ? { name: r.counterparty_name } : null),
    condition: readString(readObject(r.condition_json), "label"),
    needed_by: null,
    availability: r.availability_status,
    last_verified_at: r.last_verified_at ? iso(r.last_verified_at) : null,
    created_at: iso(r.created_at),
    mission: null,
    signal: signals.get(r.id) ?? null,
  }));
}

async function demandParties(ids: string[]): Promise<OpportunityParty[]> {
  if (ids.length === 0) return [];
  const [rows, signals] = await Promise.all([
    getDb()
      .selectFrom("demands as d")
      .leftJoin("missions as m", "m.id", "d.mission_id")
      .leftJoin("counterparties as c", "c.id", "d.counterparty_id")
      .select([
        "d.id",
        "d.description",
        "d.category",
        "d.max_budget",
        "d.target_price",
        "d.source_id",
        "d.external_ref",
        "d.fulfillment_location",
        "d.needed_by",
        "d.availability_status",
        "d.last_verified_at",
        "d.created_at",
        "m.id as mission_id",
        "m.title as mission_title",
        "c.normalized_name as counterparty_name",
      ])
      .where("d.id", "in", ids)
      .execute(),
    signalsFor("demand", ids),
  ]);
  return rows.map((r) => {
    const budget = readMoney(r.max_budget);
    return {
      kind: "demand",
      id: r.id,
      title: r.mission_title ?? r.description.slice(0, 120),
      summary: r.description,
      category: r.category,
      price: budget ?? readMoney(r.target_price),
      price_label: budget ? "Budget" : "Target price",
      quantity: null,
      platform: r.source_id,
      external_ref: r.external_ref,
      url: null,
      location: locationLabel(r.fulfillment_location),
      counterparty: r.counterparty_name ? { name: r.counterparty_name } : null,
      condition: null,
      needed_by: r.needed_by ? iso(r.needed_by) : null,
      availability: r.availability_status,
      last_verified_at: r.last_verified_at ? iso(r.last_verified_at) : null,
      created_at: iso(r.created_at),
      mission: r.mission_id && r.mission_title ? { id: r.mission_id, title: r.mission_title } : null,
      signal: signals.get(r.id) ?? null,
    };
  });
}

/** Records grouped into an entity, cheapest supply first. */
async function entityParties(entityId: string | null, memberType: "demand" | "supply"): Promise<OpportunityParty[]> {
  if (!entityId) return [];
  const members = await getDb()
    .selectFrom("entity_members")
    .select("member_id")
    .where("entity_id", "=", entityId)
    .where("member_type", "=", memberType)
    .execute();
  const ids = members.map((m) => m.member_id);
  const parties = memberType === "supply" ? await supplyParties(ids) : await demandParties(ids);
  return parties
    .sort((a, b) => (a.price?.amount ?? Number.MAX_SAFE_INTEGER) - (b.price?.amount ?? Number.MAX_SAFE_INTEGER))
    .slice(0, GRAPH_LISTINGS_PER_SIDE);
}

function readMatch(row: {
  semantic_score: number;
  constraint_score: number;
  geography_score: number;
  timing_score: number;
  quality_score: number;
  total_match_score: number;
  explanation_json: unknown;
}): OpportunityMatchDetail {
  const e = readObject(row.explanation_json);
  const terms = e?.["sharedTerms"];
  const bool = (key: string) => (typeof e?.[key] === "boolean" ? (e[key] as boolean) : null);
  return {
    scores: {
      semantic: row.semantic_score,
      constraint: row.constraint_score,
      geography: row.geography_score,
      timing: row.timing_score,
      quality: row.quality_score,
      total: row.total_match_score,
    },
    rationale: readString(e, "rationale"),
    shared_terms: Array.isArray(terms) ? terms.filter((t): t is string => typeof t === "string") : [],
    category_aligned: bool("categoryAligned"),
    within_budget: bool("withinBudget"),
  };
}

/** Both sides of an opportunity, or undefined when the opportunity does not exist. */
export async function getOpportunityDetails(opportunityId: string): Promise<OpportunityDetails | undefined> {
  const o = await getDb()
    .selectFrom("opportunities")
    .select(["kind", "match_id", "source_json"])
    .where("id", "=", opportunityId)
    .executeTakeFirst();
  if (!o) return undefined;

  if (o.match_id) {
    const m = await getDb().selectFrom("matches").selectAll().where("id", "=", o.match_id).executeTakeFirst();
    if (!m) return { kind: o.kind, sides: [], match: null };
    const [buyers, sellers] = await Promise.all([demandParties([m.demand_id]), supplyParties([m.supply_id])]);
    return {
      kind: o.kind,
      sides: [
        { role: "buyer", label: "Buyer", note: null, parties: buyers },
        { role: "seller", label: "Seller", note: null, parties: sellers },
      ],
      match: readMatch(m),
    };
  }

  const source = readObject(o.source_json);
  if (o.kind === "arbitrage") {
    const [buyFrom, sellInto, buyers] = await Promise.all([
      entityParties(readString(source, "buyEntity"), "supply"),
      entityParties(readString(source, "sellEntity"), "supply"),
      entityParties(readString(source, "sellEntity"), "demand"),
    ]);
    return {
      kind: o.kind,
      sides: [
        { role: "seller", label: "Buy from", note: readString(source, "srcTitle"), parties: buyFrom },
        {
          role: "buyer",
          label: "Sell into",
          note: `${readString(source, "dstTitle") ?? "Substitute market"}. Comparable listings set the resale price; they are not confirmed buyers.`,
          parties: [...buyers, ...sellInto],
        },
      ],
      match: null,
    };
  }
  if (o.kind === "bundle") {
    const entityId = readString(source, "entityId");
    const [sellers, buyers] = await Promise.all([entityParties(entityId, "supply"), entityParties(entityId, "demand")]);
    return {
      kind: o.kind,
      sides: [
        { role: "seller", label: "Sellers to aggregate", note: readString(source, "title"), parties: sellers },
        { role: "buyer", label: "Buyers", note: buyers.length === 0 ? "No buyer identified yet." : null, parties: buyers },
      ],
      match: null,
    };
  }
  return { kind: o.kind, sides: [], match: null };
}
