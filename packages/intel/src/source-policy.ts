/**
 * Source governance (PRD v2 FR-01, ADR-037): the deterministic rules deciding
 * whether a registered source may run. Versioned code, not model judgement
 * (ADR-015): a model may suggest a source, never clear it.
 */

export const SOURCE_POLICY_VERSION = "source-policy-1";

export type SourceKind = "search_venue" | "connector" | "apify_actor";
export type PermissionBasis = "none" | "public_search_index" | "official_api_terms" | "written_permission" | "provider_contract";
export type RegistryStatus = "proposed" | "active" | "paused" | "rejected";

/** The registry fields the policy reads. */
export interface PolicySource {
  kind: SourceKind;
  permission_basis: PermissionBasis;
  robots_tos_assessment: string | null;
  data_use_constraints: string | null;
  terms_reviewed_at: string | Date | null;
  terms_review_due_at: string | Date | null;
  apify_actor_id: string | null;
  apify_actor_version: string | null;
}

/** Which permission bases can clear each kind of source. */
const ALLOWED_BASES: Record<SourceKind, readonly PermissionBasis[]> = {
  // Only the search provider's index is read; the site itself is never fetched.
  search_venue: ["public_search_index", "official_api_terms", "written_permission", "provider_contract"],
  // An official API is used under its own terms.
  connector: ["official_api_terms", "written_permission", "provider_contract"],
  // An actor fetches the site, so the site's terms must allow it explicitly
  // (PRD §3.6: an actor does not transfer scraping compliance responsibility).
  apify_actor: ["written_permission", "provider_contract", "official_api_terms"],
};

/** Days a review stays valid when the reviewer gives no due date. */
export const DEFAULT_REVIEW_DAYS = 180;

const time = (v: string | Date | null): number | null => (v === null ? null : typeof v === "string" ? Date.parse(v) : v.getTime());

/**
 * Whether a source's permission policy is satisfied right now. Every reason it
 * is not is returned, so a reviewer sees all of them at once. A source runs
 * only with an empty list, both when it is activated and at every run (a
 * review can expire while a source is active).
 */
export function policyGaps(s: PolicySource, now: Date = new Date()): string[] {
  const gaps: string[] = [];
  if (s.permission_basis === "none") gaps.push("no_permission_basis");
  else if (!ALLOWED_BASES[s.kind].includes(s.permission_basis)) gaps.push(`permission_basis_not_allowed_for_${s.kind}`);
  if (!s.robots_tos_assessment?.trim()) gaps.push("no_robots_tos_assessment");
  const reviewed = time(s.terms_reviewed_at);
  const due = time(s.terms_review_due_at);
  if (reviewed === null) gaps.push("terms_not_reviewed");
  else if (due === null || due <= now.getTime()) gaps.push("terms_review_expired");
  if (s.kind === "apify_actor") {
    if (!s.data_use_constraints?.trim()) gaps.push("no_data_use_constraints");
    // "latest" moves under us: the reviewed program must be one fixed build.
    if (!s.apify_actor_id || !s.apify_actor_version || /^latest$/i.test(s.apify_actor_version.trim())) gaps.push("apify_actor_not_pinned");
  }
  return gaps;
}

/** Scheduling and spend fields, plus what the source has done recently. */
export interface RunnableSource extends PolicySource {
  status: RegistryStatus;
  min_interval_minutes: number | null;
  max_daily_usd: number | null;
  last_run_at: string | Date | null;
}

/**
 * Why an active source sits out this run, or null when it runs: the policy
 * (re-checked), its minimum interval since the last run, and its daily spend
 * cap against what it has cost today.
 */
export function skipReason(s: RunnableSource, spentTodayUsd: number, now: Date = new Date()): string | null {
  if (s.status !== "active") return `status_${s.status}`;
  const gaps = policyGaps(s, now);
  if (gaps.length > 0) return gaps[0]!;
  const last = time(s.last_run_at);
  if (s.min_interval_minutes && last !== null && now.getTime() - last < s.min_interval_minutes * 60_000) return "min_interval_not_elapsed";
  if (s.max_daily_usd !== null && spentTodayUsd >= s.max_daily_usd) return "daily_budget_reached";
  return null;
}

/** Searches per query before a source with no lead at all is paused. */
export const UNPRODUCTIVE_AFTER_SEARCHES = 3;
/** Consecutive failed calls before a source is marked failing and paused. */
export const FAILING_AFTER_ERRORS = 3;

/**
 * True once every query of a source has been searched at least
 * {@link UNPRODUCTIVE_AFTER_SEARCHES} times and none produced a lead. Applies
 * to built-in venues as much as submitted ones.
 */
export function isUnproductive(queries: string[], yieldByQuery: Map<string, { searches: number; leads: number }>): boolean {
  if (queries.length === 0) return false;
  let leads = 0;
  for (const q of queries) {
    const y = yieldByQuery.get(q);
    if (!y || y.searches < UNPRODUCTIVE_AFTER_SEARCHES) return false;
    leads += y.leads;
  }
  return leads === 0;
}

/** Health from consecutive failures: one is a blip, a run of them is failing. */
export function healthFor(consecutiveFailures: number): "ok" | "degraded" | "failing" {
  if (consecutiveFailures >= FAILING_AFTER_ERRORS) return "failing";
  return consecutiveFailures > 0 ? "degraded" : "ok";
}
