import type { CrmDealEvent } from "@opportunity-os/db";

/**
 * Pipedrive API client (ADR-040). Token in the `x-api-token` header; deals on
 * API v2, notes and webhooks on v1 (as Pipedrive documents them).
 */
export interface PipedriveConfig {
  companyDomain: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export interface PipedriveDealInput {
  title: string;
  value: number | null;
  currency: string;
  pipelineId?: number;
  stageId?: number;
  expectedCloseDate?: string | null;
}

export class PipedriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PipedriveError";
  }
}

export function pipedriveClient(cfg: PipedriveConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = `https://${cfg.companyDomain}.pipedrive.com`;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { "x-api-token": cfg.apiToken, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: unknown; error?: string };
    if (!res.ok || json.success === false) throw new PipedriveError(`pipedrive ${method} ${path} ${res.status}: ${String(json.error ?? "").slice(0, 200)}`, res.status);
    return json.data as T;
  }
  return {
    dealUrl: (id: string | number) => `${base}/deal/${id}`,
    async createDeal(d: PipedriveDealInput) {
      const data = await call<{ id: number; status: string; stage_id: number | null; value: number | null; currency: string | null }>("POST", "/api/v2/deals", {
        title: d.title.slice(0, 255),
        ...(d.value !== null ? { value: d.value } : {}),
        currency: d.currency,
        ...(d.pipelineId ? { pipeline_id: d.pipelineId } : {}),
        ...(d.stageId ? { stage_id: d.stageId } : {}),
        ...(d.expectedCloseDate ? { expected_close_date: d.expectedCloseDate } : {}),
      });
      return data;
    },
    async addNote(dealId: number, html: string) {
      return call<{ id: number }>("POST", "/api/v1/notes", { deal_id: dealId, content: html });
    },
    async listWebhooks() {
      return (await call<{ id: number; subscription_url: string; event_action: string; event_object: string; is_active?: number }[] | null>("GET", "/api/v1/webhooks")) ?? [];
    },
    async registerWebhook(w: { url: string; user: string; password: string }) {
      return call<{ id: number }>("POST", "/api/v1/webhooks", {
        subscription_url: w.url,
        event_action: "*",
        event_object: "deal",
        http_auth_user: w.user,
        http_auth_password: w.password,
        version: "2.0",
        name: "Opportunity OS",
      });
    },
  };
}

const STATUSES = ["open", "won", "lost", "deleted"] as const;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A Pipedrive webhook v2 delivery as a deal event, or null when it is not one
 * we act on (another entity, or a malformed body). `data` is the deal now;
 * `previous` holds what changed (or, on delete, the last state).
 */
export function parsePipedriveDealEvent(body: unknown): CrmDealEvent | null {
  if (!body || typeof body !== "object") return null;
  const { meta, data, previous } = body as { meta?: Record<string, unknown>; data?: Record<string, unknown> | null; previous?: Record<string, unknown> | null };
  if (!meta || meta["entity"] !== "deal") return null;
  const action = meta["action"];
  if (action !== "create" && action !== "change" && action !== "delete") return null;
  const entityId = meta["entity_id"];
  const eventId = meta["id"];
  if ((typeof entityId !== "string" && typeof entityId !== "number") || (typeof eventId !== "string" && typeof eventId !== "number")) return null;
  const deal = (action === "delete" ? previous : data) ?? {};
  const status = typeof deal["status"] === "string" && (STATUSES as readonly string[]).includes(deal["status"]) ? (deal["status"] as CrmDealEvent["status"]) : null;
  const ts = meta["timestamp"];
  const at = typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : typeof ts === "number" ? new Date(ts * (ts < 1e12 ? 1000 : 1)).toISOString() : null;
  return {
    provider: "pipedrive",
    eventId: String(eventId),
    action,
    entityId: String(entityId),
    at,
    status,
    stageId: num(deal["stage_id"]),
    value: num(deal["value"]),
    currency: typeof deal["currency"] === "string" ? deal["currency"] : null,
    lostReason: typeof deal["lost_reason"] === "string" && deal["lost_reason"].trim() ? deal["lost_reason"].trim().slice(0, 500) : null,
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const rng = (r: unknown) => (Array.isArray(r) && r.length === 2 ? `${usd(Number(r[0]))}–${usd(Number(r[1]))}` : "unknown");
const safeLink = (url: unknown, text: unknown) => (typeof url === "string" && /^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text ?? url)}</a>` : esc(text ?? ""));

/** The note on the Pipedrive deal: what was found, the other side, how we get paid, the economics and evidence, and a link back. */
export function dealNoteHtml(c: {
  title: string;
  lead_title?: string | null;
  lead_url?: string | null;
  lead_summary?: string | null;
  counter_url?: string | null;
  counter_summary?: string | null;
  match_rationale?: string | null;
  monetization?: { payer?: string | null; mechanism?: string | null; timing?: string | null; valueAdded?: string | null } | null;
  economics?: { deal?: { mode?: string; netProfitUsd?: unknown; probability?: unknown; daysToCash?: unknown; capitalRequiredUsd?: number; costs?: { kind: string; usd: unknown; label: string }[] } } | null;
  contact?: { channel?: string; value?: string | null } | null;
  regulatory_flags?: { flag: string }[] | null;
  fraud_flags?: { flag: string }[] | null;
}, evidence: { kind: string; url: string | null; title: string | null }[], backUrl: string | null): string {
  const d = c.economics?.deal;
  const m = c.monetization;
  const flags = [...(c.regulatory_flags ?? []), ...(c.fraud_flags ?? [])].map((f) => f.flag.replaceAll("_", " "));
  const parts = [
    `<p><b>From Opportunity OS</b>${backUrl ? ` — ${safeLink(backUrl, "open in the Action Queue")}` : ""}</p>`,
    `<p><b>Signal:</b> ${safeLink(c.lead_url, c.lead_title ?? c.title)}<br>${esc(c.lead_summary)}</p>`,
    c.counter_url || c.counter_summary ? `<p><b>Other side:</b> ${safeLink(c.counter_url, c.counter_summary ?? c.counter_url)}<br>${esc(c.match_rationale)}</p>` : "",
    m?.payer ? `<p><b>Why we get paid:</b> ${esc(m.payer)} pays a ${esc((m.mechanism ?? "").replaceAll("_", " "))}${m.timing ? `, ${esc(m.timing)}` : ""}. Value added: ${esc(m.valueAdded)}</p>` : "",
    d
      ? `<p><b>Economics (${esc(d.mode)}):</b> net ${rng(d.netProfitUsd)}, chance of closing ${Array.isArray(d.probability) ? `${Math.round(Number(d.probability[0]) * 100)}–${Math.round(Number(d.probability[1]) * 100)}%` : "unknown"}, cash in ${Array.isArray(d.daysToCash) ? `${d.daysToCash[0]}–${d.daysToCash[1]} days` : "unknown"}, capital ${usd(d.capitalRequiredUsd ?? 0)}.<br>Costs: ${(d.costs ?? []).map((x) => `${esc(x.kind)} ${rng(x.usd)} (${esc(x.label.replaceAll("_", " "))})`).join("; ") || "none"}</p>`
      : "",
    c.contact?.channel && c.contact.channel !== "unknown" ? `<p><b>Contact path:</b> ${esc(c.contact.channel.replaceAll("_", " "))}${c.contact.value ? `: ${esc(c.contact.value)}` : ""}</p>` : "",
    flags.length ? `<p><b>Flags:</b> ${esc(flags.join(", "))}</p>` : "",
    evidence.length ? `<p><b>Evidence:</b><br>${evidence.filter((e) => e.url).slice(0, 8).map((e) => `${esc(e.kind.replaceAll("_", " "))}: ${safeLink(e.url, e.title ?? e.url)}`).join("<br>")}</p>` : "",
  ];
  return parts.filter(Boolean).join("\n");
}
