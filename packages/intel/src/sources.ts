import { z } from "zod";
import { isGovernmentProcurement } from "./rules";
import type { StageOneQuery } from "./queries";

/**
 * Sources submitted at runtime into the source registry (PRD v2 FR-01,
 * ADR-037). An external agent or a member of staff proposes places where
 * demand or supply is written down; each is screened by the deterministic
 * rules here. One that passes is `proposed`: it waits for a permission-policy
 * review (source-policy.ts) before it can run. Yield then decides whether it
 * stays: an active source searched repeatedly without a lead is paused.
 *
 * A source is only ever used as a `site:` filter on the search provider — its
 * pages are never fetched (ADR-014), so a source with no public, indexed
 * pages cannot produce anything.
 */

/** One submitted source. Unknown extra fields are ignored. */
export const SubmittedSourceSchema = z.object({
  source_id: z.string().trim().max(100).optional(),
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).max(253),
  side: z.string().trim().min(1).max(40),
  sector: z.string().trim().max(200).optional(),
  geography: z.string().trim().max(200).optional(),
  signal_type: z.string().trim().max(400).optional(),
  access_method: z.string().trim().max(300).optional(),
  access_or_rights_notes: z.string().trim().max(2000).optional(),
  priority: z.string().trim().max(20).optional(),
  evidence_url: z.string().trim().max(2000).optional(),
  /** Optional search phrases; without them one is derived from the sector. */
  search_topics: z.array(z.string().trim().min(2).max(120)).max(6).optional(),
  demand_topics: z.array(z.string().trim().min(2).max(120)).max(6).optional(),
  supply_topics: z.array(z.string().trim().min(2).max(120)).max(6).optional(),
  /** A reviewer's decision to keep one side out of the pool for now, with the reason shown beside it. */
  hold: z.object({ demand: z.string().trim().min(1).max(200).optional(), supply: z.string().trim().min(1).max(200).optional() }).optional(),
});
export type SubmittedSource = z.infer<typeof SubmittedSourceSchema>;

/** The agent's report (`{ sources: [...] }`) or a bare array of sources. */
export const SourceSubmissionSchema = z.union([
  z.object({ sources: z.array(SubmittedSourceSchema).min(1).max(500) }).passthrough(),
  z.array(SubmittedSourceSchema).min(1).max(500),
]);

export type SourceOrientation = "demand" | "supply";
/** What screening can decide; only a policy review makes a source active. */
export type SourceStatus = "proposed" | "paused" | "rejected";

export interface VettedSource {
  externalId: string | null;
  name: string;
  domain: string;
  orientation: SourceOrientation;
  topics: string[];
  topicsExplicit: boolean;
  status: SourceStatus;
  statusReason: string | null;
  sector: string | null;
  geography: string | null;
  signalType: string | null;
  accessMethod: string | null;
  notes: string | null;
  priority: string | null;
  evidenceUrl: string | null;
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Sites a connector already ingests through its official API; searching them as well would double up. */
const CONNECTOR_SITES = new Set(["ebay.com", "reverb.com"]);

/** `https://www.Example.com/path` → `example.com`; undefined when it is not a hostname. */
export function normalizeDomain(raw: string): string | undefined {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  return HOSTNAME.test(host) ? host : undefined;
}

/** `both` lists on each side; anything not recognisable as demand or supply yields nothing. */
export function orientationsForSide(side: string): SourceOrientation[] {
  const s = side.toLowerCase();
  if (s === "both" || s === "mixed") return ["demand", "supply"];
  if (s.startsWith("demand")) return ["demand"];
  if (s.startsWith("supply")) return ["supply"];
  return [];
}

const STOP_WORDS = new Set(["and", "or", "the", "of", "for", "us", "b2b", "global"]);

/** A plain search phrase from the sector: no quotes or operators, a handful of words. */
export function deriveTopic(orientation: SourceOrientation, sector: string | undefined): string {
  const words = (sector ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 4);
  const subject = words.join(" ");
  return orientation === "demand" ? `${subject} request`.trim() : `${subject} for sale`.trim();
}

/** Search operators and quotes are stripped so a submitted topic can only ever be search words. */
function cleanTopic(topic: string): string {
  return topic
    .replace(/["'`]/g, " ")
    .replace(/\b(site|inurl|intitle|filetype|ext|lang|loc):/gi, " ")
    .replace(/[^\p{L}\p{N}\s[\]&,.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function vetStatus(domain: string, orientation: SourceOrientation, s: SubmittedSource): { status: SourceStatus; reason: string | null } {
  if (CONNECTOR_SITES.has(domain)) return { status: "paused", reason: "covered_by_connector" };
  // An API's documentation site has no listings on it.
  if (/^(docs|developers?|api)\./.test(domain)) return { status: "paused", reason: "documentation_host" };
  // Paid, login-only and API-only sources have nothing a search index can show ("public API" is still an API).
  if (s.access_method && !/public/i.test(s.access_method.replace(/public (\w+ )?api/gi, ""))) return { status: "paused", reason: "no_public_pages" };
  // Leads from government hosts are rejected before assessment (see isGovernmentProcurement).
  if (isGovernmentProcurement(domain) || /\.state\.[a-z]{2}\.us$/.test(domain)) return { status: "paused", reason: "government_portal_screened" };
  // A directory of who exists is not a dated offer of something available now.
  if (orientation === "supply" && /director|profile|capabilit|registered/i.test(`${s.side} ${s.signal_type ?? ""}`)) {
    return { status: "paused", reason: "directory_not_live_offers" };
  }
  const held = s.hold?.[orientation];
  if (held) return { status: "paused", reason: held };
  return { status: "proposed", reason: "awaiting_policy_review" };
}

export interface VetOutcome {
  /** One row per orientation the source lists on. */
  vetted: VettedSource[];
  /** Why the submission produced no rows at all, when it did not. */
  rejected: string | null;
}

/** Applies the vetting rules to one submitted source. */
export function vetSource(s: SubmittedSource): VetOutcome {
  const domain = normalizeDomain(s.domain);
  if (!domain) return { vetted: [], rejected: "invalid_domain" };
  const orientations = orientationsForSide(s.side);
  if (orientations.length === 0) return { vetted: [], rejected: "unknown_side" };

  const vetted = orientations.map((orientation): VettedSource => {
    const supplied = (orientation === "demand" ? s.demand_topics : s.supply_topics) ?? s.search_topics ?? [];
    const explicit = [...new Set(supplied.map(cleanTopic).filter((t) => t.length >= 2))];
    const { status, reason } = vetStatus(domain, orientation, s);
    return {
      externalId: s.source_id || null,
      name: s.name,
      domain,
      orientation,
      topics: explicit.length > 0 ? explicit : [deriveTopic(orientation, s.sector)],
      topicsExplicit: explicit.length > 0,
      status,
      statusReason: reason,
      sector: s.sector || null,
      geography: s.geography || null,
      signalType: s.signal_type || null,
      accessMethod: s.access_method || null,
      notes: s.access_or_rights_notes || null,
      priority: s.priority || null,
      evidenceUrl: s.evidence_url || null,
    };
  });
  return { vetted, rejected: null };
}

/** The stage-1 queries one source contributes. */
export function sourceQueries(source: { id?: string; domain: string; orientation: string; topics: string[] }): StageOneQuery[] {
  if (source.orientation !== "demand" && source.orientation !== "supply" && source.orientation !== "problem") return [];
  const orientation = source.orientation;
  return source.topics.map((topic) => ({ query: `site:${source.domain} ${topic}`, orientation, freshness: "month" as const, ...(source.id ? { sourceId: source.id } : {}) }));
}
