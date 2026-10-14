import type { RawObservation } from "@opportunity-os/contracts";

/** Normalized supply candidate produced from a raw observation (§3.1(5)). */
export interface NormalizedSupply {
  kind: "supply";
  source_id: string;
  external_ref: string;
  title: string;
  description: string;
  category: string | null;
  price: { amount: number; currency: string } | null;
  quantity: number | null;
  content_hash: string;
  source_reliability: number;
  /** The listing's page at its source; http(s) only, so it is safe to render as a link. */
  uri: string | null;
  seller: SupplySeller | null;
  location: SupplyLocation | null;
  /** The source's own condition label ("Brand New", "Used"). */
  condition: string | null;
}

/** Who is selling, as the source names them. */
export interface SupplySeller {
  name: string;
  /** Seller's page at the source; http(s) only. */
  url?: string;
  /** Short reputation note from the source ("99.8% positive, 1,204 ratings"). */
  detail?: string;
}

/** Where the item is, in the GeoLocation shape (`label` is ready to display). */
export interface SupplyLocation {
  label: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface NormalizedDemand {
  kind: "demand";
  source_id: string;
  external_ref: string;
  description: string;
  category: string | null;
  target_price: { amount: number; currency: string } | null;
  content_hash: string;
  source_reliability: number;
}

export type Normalized = NormalizedSupply | NormalizedDemand;

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A link from untrusted content: kept only when it parses as http(s). */
export function safeHttpUrl(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function seller(value: unknown): SupplySeller | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = asString(v["name"]);
  if (!name) return null;
  const url = safeHttpUrl(v["url"]);
  const detail = asString(v["detail"]);
  return { name, ...(url ? { url } : {}), ...(detail ? { detail } : {}) };
}

function location(value: unknown): SupplyLocation | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const parts = { city: asString(v["city"]), region: asString(v["region"]), postalCode: asString(v["postalCode"]), country: asString(v["country"]) };
  const label = asString(v["label"]) ?? [parts.city, parts.region, parts.city || parts.region ? null : parts.postalCode, parts.country].filter(Boolean).join(", ");
  if (!label) return null;
  const known = Object.fromEntries(Object.entries(parts).filter(([, x]) => x !== null)) as Omit<SupplyLocation, "label">;
  return { label, ...known };
}

function money(amount: unknown, currency: unknown): { amount: number; currency: string } | null {
  const a = asNumber(amount);
  if (a === null) return null;
  return { amount: a, currency: asString(currency) ?? "USD" };
}

/**
 * Map an untrusted raw observation to a normalized candidate. Connector content
 * is DATA, never instructions (§13.2): only known fields are read.
 */
export function normalizeObservation(obs: RawObservation): Normalized {
  const c = obs.content;
  const base = {
    source_id: obs.ref.source_id,
    external_ref: obs.ref.external_id,
    content_hash: obs.content_hash,
    source_reliability: obs.source_reliability,
    category: asString(c["category"]),
  };
  if (obs.kind === "supply") {
    return {
      kind: "supply",
      ...base,
      title: asString(c["title"]) ?? "untitled",
      description: asString(c["description"]) ?? "",
      price: money(c["price"], c["currency"]),
      quantity: asNumber(c["quantity"]),
      uri: safeHttpUrl(obs.ref.uri),
      seller: seller(c["seller"]),
      location: location(c["location"]),
      condition: asString(c["condition"]),
    };
  }
  return {
    kind: "demand",
    ...base,
    description: asString(c["description"]) ?? "",
    target_price: money(c["target_price"], c["currency"]),
  };
}
