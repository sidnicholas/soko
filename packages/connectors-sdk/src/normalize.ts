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
    };
  }
  return {
    kind: "demand",
    ...base,
    description: asString(c["description"]) ?? "",
    target_price: money(c["target_price"], c["currency"]),
  };
}
