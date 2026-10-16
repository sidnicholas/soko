import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { EventName } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";
import type { Database } from "../schema";

/**
 * Source registry (migration 0025, PRD v2 FR-01, ADR-037). The registry row is
 * the current state; source_policy_reviews keeps every review and source_runs
 * every search. Every status change commits the row, a hash-chained audit
 * event and an outbox event in one transaction. The permission policy itself
 * is deterministic code in packages/intel (source-policy.ts); functions here
 * take it as a callback so the check runs on the locked row.
 */

const json = (v: unknown) => JSON.stringify(v ?? null);

export type RegistryKind = "search_venue" | "connector" | "apify_actor";
export type RegistryStatus = "proposed" | "active" | "paused" | "rejected";
export type RegistryPermissionBasis = "none" | "public_search_index" | "official_api_terms" | "written_permission" | "provider_contract";

export interface RegistrySource {
  id: string;
  kind: RegistryKind;
  external_id: string | null;
  name: string;
  domain: string;
  url: string | null;
  orientation: string;
  topics: string[];
  markets: string[];
  sector: string | null;
  geography: string | null;
  signal_type: string | null;
  access_method: string | null;
  api_available: boolean;
  apify_actor_id: string | null;
  apify_actor_version: string | null;
  permission_basis: RegistryPermissionBasis;
  robots_tos_assessment: string | null;
  data_use_constraints: string | null;
  terms_reviewed_at: string | null;
  terms_review_due_at: string | null;
  contact_path: string | null;
  min_interval_minutes: number | null;
  cost_per_run_usd: number | null;
  max_daily_usd: number | null;
  notes: string | null;
  priority: string | null;
  evidence_url: string | null;
  status: RegistryStatus;
  status_reason: string | null;
  origin: string;
  health: "unknown" | "ok" | "degraded" | "failing";
  consecutive_failures: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  "id",
  "kind",
  "external_id",
  "name",
  "domain",
  "url",
  "orientation",
  "topics",
  "markets",
  "sector",
  "geography",
  "signal_type",
  "access_method",
  "api_available",
  "apify_actor_id",
  "apify_actor_version",
  "permission_basis",
  "robots_tos_assessment",
  "data_use_constraints",
  sql<string | null>`terms_reviewed_at::text`.as("terms_reviewed_at"),
  sql<string | null>`terms_review_due_at::text`.as("terms_review_due_at"),
  "contact_path",
  "min_interval_minutes",
  "cost_per_run_usd",
  "max_daily_usd",
  "notes",
  "priority",
  "evidence_url",
  "status",
  "status_reason",
  "origin",
  "health",
  "consecutive_failures",
  sql<string | null>`last_run_at::text`.as("last_run_at"),
  sql<string>`created_at::text`.as("created_at"),
  sql<string>`updated_at::text`.as("updated_at"),
] as const;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toSource(r: Record<string, unknown>): RegistrySource {
  return {
    ...(r as unknown as RegistrySource),
    topics: Array.isArray(r["topics"]) ? (r["topics"] as string[]) : [],
    markets: Array.isArray(r["markets"]) ? (r["markets"] as string[]) : [],
    cost_per_run_usd: num(r["cost_per_run_usd"]),
    max_daily_usd: num(r["max_daily_usd"]),
  };
}

/** A change could not be made because the source's permission policy is not satisfied. */
export class SourcePolicyError extends Error {
  constructor(readonly gaps: string[]) {
    super(`source permission policy not satisfied: ${gaps.join(", ")}`);
    this.name = "SourcePolicyError";
  }
}

export interface SourceActor {
  type: "user" | "agent" | "system";
  id: string | null;
}

async function emit(tx: Transaction<Database>, eventName: EventName, sourceId: string, actor: SourceActor, payload: Record<string, unknown>) {
  await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: eventName.replace(/\.v1$/, ""), entityType: "source", entityId: sourceId, policyVersion: (payload["policyVersion"] as string) ?? null });
  await enqueueEvent(tx, { eventName, aggregateType: "source", aggregateId: sourceId, idempotencyKey: `${eventName}:${sourceId}:${randomUUID()}`, payload: { sourceId, ...payload } });
}

export async function listSources(filter: { kind?: RegistryKind; status?: RegistryStatus } = {}): Promise<RegistrySource[]> {
  let q = getDb().selectFrom("source_registry").select(COLUMNS).orderBy("kind").orderBy("status").orderBy("domain").orderBy("orientation").limit(5000);
  if (filter.kind) q = q.where("kind", "=", filter.kind);
  if (filter.status) q = q.where("status", "=", filter.status);
  return (await q.execute()).map(toSource);
}

export async function getSource(id: string): Promise<RegistrySource | undefined> {
  const row = await getDb().selectFrom("source_registry").select(COLUMNS).where("id", "=", id).executeTakeFirst();
  return row ? toSource(row) : undefined;
}

/** The registry row for a connector, by the connector's id ("ebay-browse"). */
export async function getConnectorSource(connectorId: string): Promise<RegistrySource | undefined> {
  const row = await getDb().selectFrom("source_registry").select(COLUMNS).where("kind", "=", "connector").where("external_id", "=", connectorId).executeTakeFirst();
  return row ? toSource(row) : undefined;
}

export interface SubmittedSourceInput {
  externalId: string | null;
  name: string;
  domain: string;
  orientation: "demand" | "supply" | "problem";
  topics: string[];
  /** True when the submitter supplied the topics; derived ones never overwrite what is stored. */
  topicsExplicit: boolean;
  sector: string | null;
  geography: string | null;
  signalType: string | null;
  accessMethod: string | null;
  notes: string | null;
  priority: string | null;
  evidenceUrl: string | null;
  /** From screening: never `active` — only a review activates a source. */
  status: "proposed" | "paused" | "rejected";
  statusReason: string | null;
  origin: string;
}

/**
 * Adds a submitted search venue, or refreshes the descriptive fields of one
 * already known for that (domain, orientation). A resubmission never changes
 * status or review fields: a reviewed, paused or rejected source stays so.
 */
export async function upsertSubmittedSource(s: SubmittedSourceInput, actor: SourceActor): Promise<{ source: RegistrySource; created: boolean }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const described = {
        external_id: s.externalId,
        name: s.name,
        sector: s.sector,
        geography: s.geography,
        signal_type: s.signalType,
        access_method: s.accessMethod,
        notes: s.notes,
        priority: s.priority,
        evidence_url: s.evidenceUrl,
      };
      const row = await tx
        .insertInto("source_registry")
        .values({
          ...described,
          kind: "search_venue",
          domain: s.domain,
          orientation: s.orientation,
          topics: json(s.topics),
          status: s.status,
          status_reason: s.statusReason,
          origin: s.origin,
          // The only thing a search venue is used through; a reviewer confirms it.
          permission_basis: "public_search_index",
        })
        .onConflict((oc) =>
          oc.columns(["kind", "domain", "orientation"]).doUpdateSet({
            ...described,
            ...(s.topicsExplicit ? { topics: json(s.topics) } : {}),
            updated_at: sql`now()`,
          }),
        )
        .returning([...COLUMNS, sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();
      const { created, ...source } = row;
      if (created) {
        await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: "source.submitted", entityType: "source", entityId: row.id });
      }
      return { source: toSource(source), created };
    });
}

export interface SourceReviewInput {
  sourceId: string;
  decision: "approved" | "rejected";
  permissionBasis: RegistryPermissionBasis;
  robotsTosAssessment: string | null;
  dataUseConstraints: string | null;
  termsReviewDueAt: string;
  notes: string | null;
  reviewer: SourceActor;
  reviewerLabel: string | null;
  policyVersion: string;
  /** The permission policy, applied to the row as the review leaves it. */
  policyGaps: (source: RegistrySource) => string[];
}

/**
 * Records a permission-policy review. Approved and the policy satisfied: the
 * source becomes active. Approved but a gap remains: it stays proposed, with
 * the gaps as its reason. Rejected: rejected. Emits source.reviewed.v1, and
 * source.activated.v1 when it went active.
 */
export async function reviewSource(input: SourceReviewInput): Promise<{ source: RegistrySource; gaps: string[] } | undefined> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const before = await tx.selectFrom("source_registry").select(COLUMNS).where("id", "=", input.sourceId).forUpdate().executeTakeFirst();
      if (!before) return undefined;
      await tx
        .insertInto("source_policy_reviews")
        .values({
          source_id: input.sourceId,
          decision: input.decision,
          permission_basis: input.permissionBasis,
          robots_tos_assessment: input.robotsTosAssessment,
          data_use_constraints: input.dataUseConstraints,
          terms_review_due_at: input.termsReviewDueAt,
          notes: input.notes,
          reviewed_by: input.reviewer.type === "user" ? input.reviewer.id : null,
          reviewer_label: input.reviewerLabel,
        })
        .execute();
      const reviewed = toSource({
        ...before,
        permission_basis: input.permissionBasis,
        robots_tos_assessment: input.robotsTosAssessment,
        data_use_constraints: input.dataUseConstraints,
        terms_reviewed_at: new Date().toISOString(),
        terms_review_due_at: input.termsReviewDueAt,
      });
      const gaps = input.decision === "approved" ? input.policyGaps(reviewed) : [];
      const status: RegistryStatus = input.decision === "rejected" ? "rejected" : gaps.length === 0 ? "active" : "proposed";
      const reason = input.decision === "rejected" ? (input.notes ?? "rejected_in_review") : gaps.length > 0 ? gaps.join(",") : null;
      const row = await tx
        .updateTable("source_registry")
        .set({
          permission_basis: input.permissionBasis,
          robots_tos_assessment: input.robotsTosAssessment,
          data_use_constraints: input.dataUseConstraints,
          terms_reviewed_at: sql`now()`,
          terms_review_due_at: input.termsReviewDueAt,
          status,
          status_reason: reason,
          ...(status === "active" ? { consecutive_failures: 0, health: "unknown" } : {}),
          updated_at: sql`now()`,
        })
        .where("id", "=", input.sourceId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await emit(tx, "source.reviewed.v1", input.sourceId, input.reviewer, { decision: input.decision, status, gaps, policyVersion: input.policyVersion });
      if (status === "active" && before.status !== "active") {
        await emit(tx, "source.activated.v1", input.sourceId, input.reviewer, { reason: "review_approved", policyVersion: input.policyVersion });
      }
      return { source: toSource(row), gaps };
    });
}

/**
 * Pauses or resumes a source. Resuming re-checks the permission policy on the
 * locked row and refuses with {@link SourcePolicyError} when it is not
 * satisfied. A change to the state it is already in does nothing.
 */
export async function setSourceStatus(
  sourceId: string,
  to: "active" | "paused",
  reason: string | null,
  actor: SourceActor,
  opts: { policyGaps: (source: RegistrySource) => string[]; policyVersion: string },
): Promise<RegistrySource | undefined> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const before = await tx.selectFrom("source_registry").select(COLUMNS).where("id", "=", sourceId).forUpdate().executeTakeFirst();
      if (!before) return undefined;
      const current = toSource(before);
      if (current.status === to) return current;
      if (to === "active") {
        const gaps = opts.policyGaps(current);
        if (gaps.length > 0) throw new SourcePolicyError(gaps);
      }
      const row = await tx
        .updateTable("source_registry")
        .set({
          status: to,
          status_reason: to === "active" ? null : reason,
          ...(to === "active" ? { consecutive_failures: 0, health: "unknown" } : {}),
          updated_at: sql`now()`,
        })
        .where("id", "=", sourceId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await emit(tx, to === "active" ? "source.activated.v1" : "source.paused.v1", sourceId, actor, { reason, policyVersion: opts.policyVersion });
      return toSource(row);
    });
}

export interface SourceRunRecord {
  sourceId: string | null;
  intelRunId: string | null;
  query: string;
  results: number;
  newResults: number;
  leads: number;
  costUsd: number;
  error: string | null;
}

export async function recordSourceRuns(runs: SourceRunRecord[]): Promise<void> {
  if (runs.length === 0) return;
  await getDb()
    .insertInto("source_runs")
    .values(
      runs.map((r) => ({
        source_id: r.sourceId,
        intel_run_id: r.intelRunId,
        query: r.query,
        results: r.results,
        new_results: r.newResults,
        leads: r.leads,
        cost_usd: r.costUsd.toFixed(6),
        error: r.error,
      })),
    )
    .execute();
}

/**
 * Records one call's outcome on the source: last run time, the failure streak
 * (reset by a success) and the health the caller derives from it.
 */
export async function recordSourceOutcome(sourceId: string, ok: boolean, healthFor: (consecutiveFailures: number) => string): Promise<RegistrySource | undefined> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const before = await tx.selectFrom("source_registry").select(["consecutive_failures"]).where("id", "=", sourceId).forUpdate().executeTakeFirst();
      if (!before) return undefined;
      const failures = ok ? 0 : before.consecutive_failures + 1;
      const row = await tx
        .updateTable("source_registry")
        .set({ last_run_at: sql`now()`, consecutive_failures: failures, health: healthFor(failures) })
        .where("id", "=", sourceId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return toSource(row);
    });
}

/** What each source has cost since the start of the UTC day. */
export async function sourceSpendToday(): Promise<Map<string, number>> {
  const rows = await getDb()
    .selectFrom("source_runs")
    .select(["source_id", sql<string>`sum(cost_usd)`.as("usd")])
    .where("source_id", "is not", null)
    .where(sql<boolean>`created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
    .groupBy("source_id")
    .execute();
  return new Map(rows.map((r) => [r.source_id!, Number(r.usd)]));
}

/** Searches and leads per query, from the registry's run records (auto-pause input). */
export async function sourceQueryStats(): Promise<Map<string, { searches: number; leads: number }>> {
  const rows = await getDb()
    .selectFrom("source_runs")
    .select(["query", sql<number>`count(*)::int`.as("searches"), sql<number>`coalesce(sum(leads), 0)::int`.as("leads")])
    .where("error", "is", null)
    .groupBy("query")
    .execute();
  return new Map(rows.map((r) => [r.query, { searches: r.searches, leads: r.leads }]));
}

export interface SourceYield {
  searches: number;
  results: number;
  leads: number;
  actionable: number;
  errors: number;
  costUsd: number;
  lastRunAt: string | null;
}

/** Yield per source over the last `days` days: searches, results, leads, actionable candidates, errors and cost. */
export async function sourceYield(days = 30): Promise<Map<string, SourceYield>> {
  const result = await sql<{ source_id: string; searches: number; results: number; leads: number; errors: number; cost: string; last_run_at: string | null; actionable: number }>`
    with r as (
      select source_id, count(*)::int as searches, coalesce(sum(results), 0)::int as results, coalesce(sum(leads), 0)::int as leads,
             count(*) filter (where error is not null)::int as errors, coalesce(sum(cost_usd), 0) as cost, max(created_at)::text as last_run_at
      from source_runs
      where source_id is not null and created_at >= now() - make_interval(days => ${days})
      group by source_id
    ),
    q as (
      select distinct source_id, query from source_runs
      where source_id is not null and created_at >= now() - make_interval(days => ${days})
    ),
    a as (
      select q.source_id, count(distinct c.id) filter (where c.bucket in ('act_now', 'verify_next'))::int as actionable
      from q join intel_leads l on l.query = q.query left join intel_candidates c on c.lead_id = l.id
      group by q.source_id
    )
    select r.*, coalesce(a.actionable, 0)::int as actionable from r left join a on a.source_id = r.source_id
  `.execute(getDb());
  return new Map(
    result.rows.map((r) => [
      r.source_id,
      { searches: r.searches, results: r.results, leads: r.leads, actionable: r.actionable, errors: r.errors, costUsd: Number(r.cost), lastRunAt: r.last_run_at },
    ]),
  );
}

export async function listSourceReviews(sourceId: string) {
  return getDb()
    .selectFrom("source_policy_reviews")
    .select(["id", "decision", "permission_basis", "robots_tos_assessment", "data_use_constraints", sql<string | null>`terms_review_due_at::text`.as("terms_review_due_at"), "notes", "reviewed_by", "reviewer_label", sql<string>`created_at::text`.as("created_at")])
    .where("source_id", "=", sourceId)
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();
}

export async function listSourceRuns(sourceId: string, limit = 50) {
  return getDb()
    .selectFrom("source_runs")
    .select(["id", "intel_run_id", "query", "results", "new_results", "leads", sql<number>`cost_usd::float`.as("cost_usd"), "error", sql<string>`created_at::text`.as("created_at")])
    .where("source_id", "=", sourceId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
