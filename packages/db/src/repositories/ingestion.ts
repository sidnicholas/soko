import { sql } from "kysely";
import { getDb } from "../pool";
import { appendAuditEvent } from "./audit";
import { getSource, type RegistrySource, type SourceActor } from "./sources";

/**
 * Apify ingestion (migration 0031, PRD v2 FR-01, ADR-042): actor sources and
 * their configuration, actor runs, the observation ledger every source writes
 * (provenance, duplicates, cross-source merge) and the quarantine.
 */

const json = (v: unknown) => JSON.stringify(v ?? null);

export interface ApifySourceConfig {
  actorId: string;
  actorVersion: string;
  input: unknown;
  fieldMap: unknown;
  expectedFields: string[] | null;
  maxItems: number | null;
  maxChargeUsd: number | null;
}

export interface ApifySource extends RegistrySource {
  apify_input: unknown;
  apify_field_map: unknown;
  apify_expected_fields: string[] | null;
  apify_max_items: number | null;
  apify_max_charge_usd: number | null;
}

/** A source with its Apify configuration. */
export async function getApifySource(id: string): Promise<ApifySource | undefined> {
  const source = await getSource(id);
  if (!source || source.kind !== "apify_actor") return undefined;
  const cfg = await getDb()
    .selectFrom("source_registry")
    .select(["apify_input", "apify_field_map", "apify_expected_fields", "apify_max_items", sql<number | null>`apify_max_charge_usd::float`.as("apify_max_charge_usd")])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { ...source, ...cfg, apify_expected_fields: Array.isArray(cfg.apify_expected_fields) ? (cfg.apify_expected_fields as string[]) : null };
}

export async function listApifySources(status?: string): Promise<ApifySource[]> {
  let q = getDb().selectFrom("source_registry").select("id").where("kind", "=", "apify_actor");
  if (status) q = q.where("status", "=", status);
  const ids = await q.orderBy("created_at").execute();
  return (await Promise.all(ids.map((r) => getApifySource(r.id)))).filter((s): s is ApifySource => !!s);
}

/**
 * Registers an Apify actor as a source. It arrives `proposed`, with no
 * permission basis: only a policy review activates it (ADR-037).
 */
export async function registerApifySource(
  input: { name: string; domain: string; orientation: "demand" | "supply"; notes: string | null; evidenceUrl: string | null; minIntervalMinutes: number | null; maxDailyUsd: number | null } & ApifySourceConfig,
  actor: SourceActor,
): Promise<ApifySource> {
  const id = await getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("source_registry")
        .values({
          kind: "apify_actor",
          external_id: input.actorId,
          name: input.name,
          domain: input.domain,
          orientation: input.orientation,
          topics: json([]),
          status: "proposed",
          status_reason: "awaiting_policy_review",
          origin: "staff_upload",
          notes: input.notes,
          evidence_url: input.evidenceUrl,
          access_method: "apify_actor",
          apify_actor_id: input.actorId,
          apify_actor_version: input.actorVersion,
          apify_input: json(input.input ?? {}),
          apify_field_map: json(input.fieldMap),
          apify_expected_fields: input.expectedFields ? json(input.expectedFields) : null,
          apify_max_items: input.maxItems,
          apify_max_charge_usd: input.maxChargeUsd,
          min_interval_minutes: input.minIntervalMinutes,
          max_daily_usd: input.maxDailyUsd,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: "source.submitted", entityType: "source", entityId: row.id });
      return row.id;
    });
  return (await getApifySource(id))!;
}

/**
 * Changes an actor's configuration. A different actor or build is a different
 * program fetching the site: an active source goes back to `proposed` for a
 * new review.
 */
export async function updateApifyConfig(sourceId: string, cfg: Partial<ApifySourceConfig>, actor: SourceActor): Promise<ApifySource | undefined> {
  const done = await getDb()
    .transaction()
    .execute(async (tx) => {
      const before = await tx.selectFrom("source_registry").select(["kind", "status", "apify_actor_id", "apify_actor_version"]).where("id", "=", sourceId).forUpdate().executeTakeFirst();
      if (!before || before.kind !== "apify_actor") return false;
      const programChanged = (cfg.actorId !== undefined && cfg.actorId !== before.apify_actor_id) || (cfg.actorVersion !== undefined && cfg.actorVersion !== before.apify_actor_version);
      await tx
        .updateTable("source_registry")
        .set({
          ...(cfg.actorId !== undefined ? { apify_actor_id: cfg.actorId, external_id: cfg.actorId } : {}),
          ...(cfg.actorVersion !== undefined ? { apify_actor_version: cfg.actorVersion } : {}),
          ...(cfg.input !== undefined ? { apify_input: json(cfg.input) } : {}),
          ...(cfg.fieldMap !== undefined ? { apify_field_map: json(cfg.fieldMap) } : {}),
          ...(cfg.expectedFields !== undefined ? { apify_expected_fields: cfg.expectedFields ? json(cfg.expectedFields) : null } : {}),
          ...(cfg.maxItems !== undefined ? { apify_max_items: cfg.maxItems } : {}),
          ...(cfg.maxChargeUsd !== undefined ? { apify_max_charge_usd: cfg.maxChargeUsd } : {}),
          ...(programChanged && before.status === "active" ? { status: "proposed", status_reason: "apify_actor_changed_needs_review", terms_reviewed_at: null } : {}),
          updated_at: sql`now()`,
        })
        .where("id", "=", sourceId)
        .execute();
      await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: programChanged ? "source.apify_actor_changed" : "source.apify_config_changed", entityType: "source", entityId: sourceId });
      return true;
    });
  return done ? getApifySource(sourceId) : undefined;
}

/** Records the fields a source returns, learnt from its first run when the reviewer gave none. */
export async function setExpectedFields(sourceId: string, fields: string[]): Promise<void> {
  await getDb().updateTable("source_registry").set({ apify_expected_fields: json([...new Set(fields)].sort()), updated_at: sql`now()` }).where("id", "=", sourceId).execute();
}

// ---------------------------------------------------------------------------
// Actor runs

export interface ApifyRunRow {
  id: string;
  source_id: string;
  apify_run_id: string;
  dataset_id: string | null;
  status: "running" | "ingesting" | "succeeded" | "failed";
  apify_status: string | null;
  max_charge_usd: number | null;
  usage_usd: number | null;
  items_total: number;
  items_new: number;
  items_changed: number;
  items_duplicate: number;
  items_merged: number;
  items_quarantined: number;
  error: string | null;
  retry_after: string | null;
  started_at: string;
  finished_at: string | null;
}

const RUN_COLUMNS = [
  "id",
  "source_id",
  "apify_run_id",
  "dataset_id",
  "status",
  "apify_status",
  sql<number | null>`max_charge_usd::float`.as("max_charge_usd"),
  sql<number | null>`usage_usd::float`.as("usage_usd"),
  "items_total",
  "items_new",
  "items_changed",
  "items_duplicate",
  "items_merged",
  "items_quarantined",
  "error",
  sql<string | null>`retry_after::text`.as("retry_after"),
  sql<string>`started_at::text`.as("started_at"),
  sql<string | null>`finished_at::text`.as("finished_at"),
] as const;
const toRun = (r: unknown) => r as ApifyRunRow;

export async function createApifyRun(sourceId: string, run: { apifyRunId: string; datasetId: string | null; apifyStatus: string; maxChargeUsd: number | null }): Promise<ApifyRunRow> {
  const row = await getDb()
    .insertInto("apify_runs")
    .values({ source_id: sourceId, apify_run_id: run.apifyRunId, dataset_id: run.datasetId, apify_status: run.apifyStatus, max_charge_usd: run.maxChargeUsd })
    .returning(RUN_COLUMNS)
    .executeTakeFirstOrThrow();
  await getDb().updateTable("source_registry").set({ last_run_at: sql`now()` }).where("id", "=", sourceId).execute();
  return toRun(row);
}

export async function getApifyRunByApifyId(apifyRunId: string): Promise<ApifyRunRow | undefined> {
  const row = await getDb().selectFrom("apify_runs").select(RUN_COLUMNS).where("apify_run_id", "=", apifyRunId).executeTakeFirst();
  return row ? toRun(row) : undefined;
}

export async function listApifyRuns(sourceId: string, limit = 20): Promise<ApifyRunRow[]> {
  return (await getDb().selectFrom("apify_runs").select(RUN_COLUMNS).where("source_id", "=", sourceId).orderBy("started_at", "desc").limit(limit).execute()).map(toRun);
}

/** Runs still open: running at Apify, or claimed for ingestion by a process that died (stale after 30 minutes). */
export async function listOpenApifyRuns(): Promise<ApifyRunRow[]> {
  return (
    await getDb()
      .selectFrom("apify_runs")
      .select(RUN_COLUMNS)
      .where((eb) => eb.or([eb("status", "=", "running"), eb.and([eb("status", "=", "ingesting"), sql<boolean>`updated_at < now() - interval '30 minutes'`])]))
      .orderBy("started_at")
      .limit(50)
      .execute()
  ).map(toRun);
}

/** The source's open run, if any, and when it may run again after a failure. */
export async function apifySourceState(sourceId: string): Promise<{ open: boolean; retryAfter: string | null }> {
  const open = await getDb().selectFrom("apify_runs").select("id").where("source_id", "=", sourceId).where("status", "in", ["running", "ingesting"]).executeTakeFirst();
  const last = await getDb().selectFrom("apify_runs").select(["status", sql<string | null>`retry_after::text`.as("retry_after")]).where("source_id", "=", sourceId).orderBy("started_at", "desc").executeTakeFirst();
  return { open: !!open, retryAfter: last?.status === "failed" ? last.retry_after : null };
}

/** Consecutive failed runs of a source, newest first, stopping at the last success. */
export async function apifyFailureStreak(sourceId: string): Promise<number> {
  const rows = await getDb().selectFrom("apify_runs").select("status").where("source_id", "=", sourceId).where("status", "in", ["succeeded", "failed"]).orderBy("started_at", "desc").limit(10).execute();
  let n = 0;
  for (const r of rows) {
    if (r.status !== "failed") break;
    n++;
  }
  return n;
}

export async function setApifyRunStatus(id: string, apifyStatus: string): Promise<void> {
  await getDb().updateTable("apify_runs").set({ apify_status: apifyStatus, updated_at: sql`now()` }).where("id", "=", id).execute();
}

/**
 * Claims a finished run for ingestion. Only one caller wins (the webhook and
 * the poller can both see the run finish); the loser gets false.
 */
export async function claimApifyRun(id: string, apifyStatus: string, datasetId: string | null, usageUsd: number | null): Promise<boolean> {
  const row = await getDb()
    .updateTable("apify_runs")
    .set({ status: "ingesting", apify_status: apifyStatus, dataset_id: datasetId, usage_usd: usageUsd, updated_at: sql`now()` })
    .where("id", "=", id)
    .where((eb) => eb.or([eb("status", "=", "running"), eb.and([eb("status", "=", "ingesting"), sql<boolean>`updated_at < now() - interval '30 minutes'`])]))
    .returning("id")
    .executeTakeFirst();
  return !!row;
}

export interface RunCounts {
  total: number;
  new: number;
  changed: number;
  duplicate: number;
  merged: number;
  quarantined: number;
}

export async function finishApifyRun(id: string, counts: RunCounts): Promise<void> {
  await getDb()
    .updateTable("apify_runs")
    .set({
      status: "succeeded",
      items_total: counts.total,
      items_new: counts.new,
      items_changed: counts.changed,
      items_duplicate: counts.duplicate,
      items_merged: counts.merged,
      items_quarantined: counts.quarantined,
      finished_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .where("id", "=", id)
    .execute();
}

/** A failed run, with when its source may try again. */
export async function failApifyRun(id: string, run: { apifyStatus: string | null; usageUsd: number | null; error: string; retryAfter: string }): Promise<void> {
  await getDb()
    .updateTable("apify_runs")
    .set({ status: "failed", apify_status: run.apifyStatus, usage_usd: run.usageUsd, error: run.error.slice(0, 1000), retry_after: run.retryAfter, finished_at: sql`now()`, updated_at: sql`now()` })
    .where("id", "=", id)
    .execute();
}

/** Spend on every Apify source today (UTC), for the global cap. */
export async function apifySpendToday(): Promise<number> {
  const row = await getDb()
    .selectFrom("source_runs as r")
    .innerJoin("source_registry as s", "s.id", "r.source_id")
    .select(sql<string>`coalesce(sum(r.cost_usd), 0)`.as("usd"))
    .where("s.kind", "=", "apify_actor")
    .where(sql<boolean>`r.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
    .executeTakeFirst();
  // Runs still open have no cost recorded yet: count their caps so parallel runs cannot overshoot.
  const open = await getDb().selectFrom("apify_runs").select(sql<string>`coalesce(sum(max_charge_usd), 0)`.as("usd")).where("status", "in", ["running", "ingesting"]).executeTakeFirst();
  return Number(row?.usd ?? 0) + Number(open?.usd ?? 0);
}

// ---------------------------------------------------------------------------
// Observations: provenance, duplicates and cross-source merge

export type ObservationState = "new" | "changed" | "duplicate";

/** Whether this source has seen this item before, and with the same content. */
export async function observationState(sourceId: string, externalId: string, contentHash: string): Promise<{ state: ObservationState; supplyId: string | null; merged: boolean }> {
  const row = await getDb().selectFrom("source_observations").select(["content_hash", "supply_id", "merged"]).where("source_id", "=", sourceId).where("external_id", "=", externalId).executeTakeFirst();
  if (!row) return { state: "new", supplyId: null, merged: false };
  return { state: row.content_hash === contentHash ? "duplicate" : "changed", supplyId: row.supply_id, merged: row.merged };
}

/** A listing already stored from another source with the same identity, to merge into. */
export async function findMergeTarget(canonicalKey: string | null, sourceId: string): Promise<string | null> {
  if (!canonicalKey) return null;
  const row = await getDb()
    .selectFrom("source_observations")
    .select("supply_id")
    .where("canonical_key", "=", canonicalKey)
    .where("source_id", "<>", sourceId)
    .where("supply_id", "is not", null)
    .orderBy("first_seen_at")
    .executeTakeFirst();
  return row?.supply_id ?? null;
}

export async function saveObservation(o: {
  sourceId: string;
  apifyRunId: string | null;
  kind: "supply" | "demand";
  externalId: string;
  canonicalKey: string | null;
  contentHash: string;
  content: unknown;
  supplyId: string | null;
  merged: boolean;
}): Promise<void> {
  await getDb()
    .insertInto("source_observations")
    .values({
      source_id: o.sourceId,
      apify_run_id: o.apifyRunId,
      kind: o.kind,
      external_id: o.externalId,
      canonical_key: o.canonicalKey,
      content_hash: o.contentHash,
      content: json(o.content),
      supply_id: o.supplyId,
      merged: o.merged,
    })
    .onConflict((oc) =>
      oc.columns(["source_id", "external_id"]).doUpdateSet({
        apify_run_id: sql`coalesce(excluded.apify_run_id, source_observations.apify_run_id)`,
        canonical_key: sql`coalesce(excluded.canonical_key, source_observations.canonical_key)`,
        content_hash: o.contentHash,
        content: json(o.content),
        supply_id: sql`coalesce(excluded.supply_id, source_observations.supply_id)`,
        merged: sql`source_observations.merged or excluded.merged`,
        last_seen_at: sql`now()`,
        seen_count: sql`source_observations.seen_count + 1`,
      }),
    )
    .execute();
}

/** Marks a merged listing as seen again (the other source is still showing it). */
export async function touchSupply(supplyId: string): Promise<void> {
  await getDb().updateTable("supply").set({ last_verified_at: new Date().toISOString(), availability_status: "available" }).where("id", "=", supplyId).execute();
}

/** Every source a listing was seen through. */
export async function listObservationsForSupply(supplyId: string) {
  return getDb()
    .selectFrom("source_observations as o")
    .innerJoin("source_registry as s", "s.id", "o.source_id")
    .select(["o.id", "o.source_id", "s.name as source_name", "s.kind as source_kind", "o.external_id", "o.merged", "o.seen_count", sql<string>`o.first_seen_at::text`.as("first_seen_at"), sql<string>`o.last_seen_at::text`.as("last_seen_at")])
    .where("o.supply_id", "=", supplyId)
    .orderBy("o.first_seen_at")
    .execute();
}

// ---------------------------------------------------------------------------
// Quarantine

export type QuarantineReasonCode = "unexpected_fields" | "missing_required" | "invalid_value" | "category_unmapped" | "prompt_injection";

export interface QuarantineRow {
  id: string;
  source_id: string;
  source_name: string;
  apify_run_id: string | null;
  external_id: string | null;
  reason: QuarantineReasonCode;
  fields: string[];
  item: unknown;
  status: "pending" | "released" | "discarded";
  created_at: string;
}

/** Items larger than this are stored as their field names only. */
const MAX_ITEM_CHARS = 20_000;

export async function quarantineItem(q: { sourceId: string; apifyRunId: string | null; externalId: string | null; reason: QuarantineReasonCode; fields: string[]; item: unknown }): Promise<void> {
  const raw = JSON.stringify(q.item ?? null);
  const item = raw.length <= MAX_ITEM_CHARS ? q.item : { truncated: true, fields: q.item && typeof q.item === "object" ? Object.keys(q.item as object).slice(0, 200) : [] };
  await getDb()
    .insertInto("ingestion_quarantine")
    .values({ source_id: q.sourceId, apify_run_id: q.apifyRunId, external_id: q.externalId, reason: q.reason, fields: json(q.fields), item: json(item) })
    .execute();
}

export async function listQuarantine(opts: { status?: "pending" | "released" | "discarded"; sourceId?: string; limit?: number } = {}): Promise<QuarantineRow[]> {
  let q = getDb()
    .selectFrom("ingestion_quarantine as q")
    .innerJoin("source_registry as s", "s.id", "q.source_id")
    .select(["q.id", "q.source_id", "s.name as source_name", "q.apify_run_id", "q.external_id", "q.reason", "q.fields", "q.item", "q.status", sql<string>`q.created_at::text`.as("created_at")])
    .where("q.status", "=", opts.status ?? "pending");
  if (opts.sourceId) q = q.where("q.source_id", "=", opts.sourceId);
  return (await q.orderBy("q.created_at", "desc").limit(Math.min(opts.limit ?? 100, 500)).execute()) as unknown as QuarantineRow[];
}

export async function getQuarantineItem(id: string): Promise<QuarantineRow | undefined> {
  const row = await getDb()
    .selectFrom("ingestion_quarantine as q")
    .innerJoin("source_registry as s", "s.id", "q.source_id")
    .select(["q.id", "q.source_id", "s.name as source_name", "q.apify_run_id", "q.external_id", "q.reason", "q.fields", "q.item", "q.status", sql<string>`q.created_at::text`.as("created_at")])
    .where("q.id", "=", id)
    .executeTakeFirst();
  return row as unknown as QuarantineRow | undefined;
}

/** Marks a pending item released or discarded, once; returns false when it was not pending. */
export async function resolveQuarantine(id: string, status: "released" | "discarded", actor: SourceActor): Promise<boolean> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .updateTable("ingestion_quarantine")
        .set({ status, resolved_by: actor.type === "user" ? actor.id : null, resolved_at: sql`now()` })
        .where("id", "=", id)
        .where("status", "=", "pending")
        .returning("source_id")
        .executeTakeFirst();
      if (!row) return false;
      await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: `ingestion.quarantine_${status}`, entityType: "source", entityId: row.source_id });
      return true;
    });
}

export async function quarantineCounts(): Promise<Map<string, number>> {
  const rows = await getDb().selectFrom("ingestion_quarantine").select(["source_id", sql<number>`count(*)::int`.as("n")]).where("status", "=", "pending").groupBy("source_id").execute();
  return new Map(rows.map((r) => [r.source_id, r.n]));
}
