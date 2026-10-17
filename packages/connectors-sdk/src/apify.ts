import { createHash } from "node:crypto";
import type { RawObservation } from "@opportunity-os/contracts";

/**
 * Apify (PRD v2 FR-01, ADR-042): start a pinned actor build, read its run and
 * its dataset. Token in the Authorization header. An actor's output is
 * untrusted third-party data: only the fields its source maps are read, and
 * anything unexpected is quarantined for a person, never guessed at.
 */
export interface ApifyConfig {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type ApifyRunStatus = "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMING-OUT" | "TIMED-OUT" | "ABORTING" | "ABORTED";
export const APIFY_TERMINAL: readonly ApifyRunStatus[] = ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"];

export interface ApifyRun {
  id: string;
  actId?: string;
  status: ApifyRunStatus;
  defaultDatasetId?: string;
  usageTotalUsd?: number | null;
  statusMessage?: string | null;
}

export interface StartRunInput {
  actorId: string;
  /** Build tag or number; the registry pins it. */
  build: string;
  input: unknown;
  maxItems?: number | null;
  maxTotalChargeUsd?: number | null;
  timeoutSecs?: number;
  /** Completion webhook: called on every terminal state, with our secret header. */
  webhook?: { url: string; secret: string } | null;
}

export class ApifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApifyError";
  }
}

export function apifyClient(cfg: ApifyConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = (cfg.baseUrl ?? "https://api.apify.com").replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApifyError(`apify ${method} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }
  return {
    async startRun(r: StartRunInput): Promise<ApifyRun> {
      const params = new URLSearchParams({ build: r.build });
      if (r.maxItems) params.set("maxItems", String(r.maxItems));
      if (r.maxTotalChargeUsd !== null && r.maxTotalChargeUsd !== undefined) params.set("maxTotalChargeUsd", r.maxTotalChargeUsd.toFixed(4));
      if (r.timeoutSecs) params.set("timeout", String(r.timeoutSecs));
      if (r.webhook) {
        const hooks = [
          {
            eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
            requestUrl: r.webhook.url,
            headersTemplate: JSON.stringify({ "x-apify-webhook-secret": r.webhook.secret }),
          },
        ];
        params.set("webhooks", Buffer.from(JSON.stringify(hooks), "utf8").toString("base64"));
      }
      // Actor ids are "username~name" or an id; a "/" form is accepted too.
      const actor = encodeURIComponent(r.actorId.replace("/", "~"));
      return (await call<{ data: ApifyRun }>("POST", `/v2/acts/${actor}/runs?${params.toString()}`, r.input ?? {})).data;
    },
    async getRun(runId: string): Promise<ApifyRun> {
      return (await call<{ data: ApifyRun }>("GET", `/v2/actor-runs/${encodeURIComponent(runId)}`)).data;
    },
    async datasetItems(datasetId: string, offset: number, limit: number): Promise<unknown[]> {
      const params = new URLSearchParams({ format: "json", clean: "true", offset: String(offset), limit: String(limit) });
      const items = await call<unknown>("GET", `/v2/datasets/${encodeURIComponent(datasetId)}/items?${params.toString()}`);
      return Array.isArray(items) ? items : [];
    },
  };
}
export type ApifyClient = ReturnType<typeof apifyClient>;

/**
 * How one dataset item becomes an observation. Each value is a field path in
 * the item ("price.value", "images.0") or a constant written "const:USD".
 */
export interface ApifyFieldMap {
  kind: "supply" | "demand";
  externalId: string;
  title: string;
  description?: string;
  url?: string;
  price?: string;
  /** "major" (12.5 = $12.50, the default) or "minor" (1250 = $12.50). */
  priceUnit?: "major" | "minor";
  currency?: string;
  category?: string;
  quantity?: string;
  condition?: string;
  sellerName?: string;
  sellerUrl?: string;
  location?: string;
}

const MAP_KEYS: (keyof ApifyFieldMap)[] = ["externalId", "title", "description", "url", "price", "currency", "category", "quantity", "condition", "sellerName", "sellerUrl", "location"];

/** A field map from untrusted input (a reviewer's form or an API body), or the list of what is wrong with it. */
export function parseFieldMap(v: unknown): { map: ApifyFieldMap } | { errors: string[] } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { errors: ["field map must be an object"] };
  const o = v as Record<string, unknown>;
  const errors: string[] = [];
  if (o["kind"] !== "supply" && o["kind"] !== "demand") errors.push("kind must be supply or demand");
  if (o["priceUnit"] !== undefined && o["priceUnit"] !== "major" && o["priceUnit"] !== "minor") errors.push("priceUnit must be major or minor");
  for (const k of MAP_KEYS) {
    const val = o[k];
    if (val === undefined || val === null || val === "") {
      if (k === "externalId" || k === "title") errors.push(`${k} is required`);
      continue;
    }
    if (typeof val !== "string" || val.length > 200) errors.push(`${k} must be a field path or const:value`);
  }
  if (errors.length) return { errors };
  const map: Record<string, unknown> = { kind: o["kind"] };
  if (o["priceUnit"]) map["priceUnit"] = o["priceUnit"];
  for (const k of MAP_KEYS) if (typeof o[k] === "string" && o[k]) map[k] = o[k];
  return { map: map as unknown as ApifyFieldMap };
}

/** The top-level item fields a map reads (constants read none). */
export function mappedRoots(map: ApifyFieldMap): string[] {
  return [...new Set(MAP_KEYS.map((k) => map[k]).filter((p): p is string => typeof p === "string" && !p.startsWith("const:")).map((p) => p.split(".")[0]!))];
}

function read(item: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  if (path.startsWith("const:")) return path.slice(6);
  let cur: unknown = item;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const text = (v: unknown, max: number): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

const number = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // "$1,250.50" reads as 1250.5; text with no digits ("call us") is not a number.
    const cleaned = v.replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return /\d/.test(cleaned) && Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * The identity of a listing across sources, so the same item seen through an
 * official API and an actor merges into one: host without "www." plus path,
 * lowercased, no query or trailing slash; eBay items by item number.
 */
export function canonicalListingKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (/(^|\.)ebay\.[a-z.]+$/.test(host)) {
      const id = /\/itm\/(?:[^/]+\/)?(\d{9,15})/.exec(u.pathname)?.[1];
      if (id) return `ebay/itm/${id}`;
    }
    return `${host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

export type QuarantineReason = "unexpected_fields" | "missing_required" | "invalid_value" | "category_unmapped" | "prompt_injection";

export type MappedApifyItem =
  | { ok: true; observation: RawObservation; canonicalKey: string | null }
  | { ok: false; reason: QuarantineReason; fields: string[]; externalId: string | null };

/**
 * One dataset item as an observation, or why it is quarantined. Unexpected
 * top-level fields mean the actor's output changed shape since review, so the
 * item waits for a person rather than being read on a guess. `acceptUnexpected`
 * is set when a person released it.
 */
export function mapApifyItem(sourceId: string, raw: unknown, map: ApifyFieldMap, expectedFields: string[] | null, opts: { acceptUnexpected?: boolean; now?: Date } = {}): MappedApifyItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "invalid_value", fields: ["(item)"], externalId: null };
  const item = raw as Record<string, unknown>;
  const externalIdRaw = read(item, map.externalId);
  const externalId = typeof externalIdRaw === "string" || typeof externalIdRaw === "number" ? String(externalIdRaw).slice(0, 300) : null;
  if (expectedFields && !opts.acceptUnexpected) {
    const known = new Set([...expectedFields, ...mappedRoots(map)]);
    const extra = Object.keys(item).filter((k) => !known.has(k));
    if (extra.length) return { ok: false, reason: "unexpected_fields", fields: extra.slice(0, 50), externalId };
  }
  const title = text(read(item, map.title), 300);
  const missing = [!externalId ? map.externalId : null, !title ? map.title : null].filter((x): x is string => !!x);
  if (missing.length) return { ok: false, reason: "missing_required", fields: missing, externalId };

  const priceRaw = read(item, map.price);
  const price = number(priceRaw);
  if (map.price && priceRaw !== undefined && priceRaw !== null && priceRaw !== "" && price === null) return { ok: false, reason: "invalid_value", fields: [map.price], externalId };
  const urlRaw = read(item, map.url);
  const url = typeof urlRaw === "string" && /^https?:\/\//i.test(urlRaw) ? urlRaw : undefined;
  const sellerName = text(read(item, map.sellerName), 200);
  const sellerUrl = read(item, map.sellerUrl);
  const location = text(read(item, map.location), 200);
  const content: Record<string, unknown> = {
    title,
    description: text(read(item, map.description), 1000) ?? "",
    category: text(read(item, map.category), 200),
    // Stored in minor units like every other connector.
    price: price === null ? null : Math.round(map.priceUnit === "minor" ? price : price * 100),
    currency: (text(read(item, map.currency), 3) ?? "USD").toUpperCase(),
    quantity: number(read(item, map.quantity)),
    condition: text(read(item, map.condition), 100),
    ...(sellerName ? { seller: { name: sellerName, ...(typeof sellerUrl === "string" && /^https?:\/\//i.test(sellerUrl) ? { url: sellerUrl } : {}) } } : {}),
    ...(location ? { location: { label: location } } : {}),
  };
  return {
    ok: true,
    canonicalKey: canonicalListingKey(url),
    observation: {
      ref: { source_id: sourceId, external_id: externalId!, ...(url ? { uri: url } : {}) },
      kind: map.kind,
      captured_at: (opts.now ?? new Date()).toISOString(),
      content,
      // Of the whole item as the actor returned it: a change anywhere is a change.
      content_hash: createHash("sha256").update(JSON.stringify(item), "utf8").digest("hex"),
      source_reliability: 0.6,
      automation: "licensed_feed",
    },
  };
}
