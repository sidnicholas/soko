import type { RawObservation } from "@opportunity-os/contracts";
import {
  APIFY_TERMINAL,
  canonicalCategory,
  mapApifyItem,
  normalizeObservation,
  parseFieldMap,
  type ApifyClient,
  type ApifyFieldMap,
  type ApifyRun,
} from "@opportunity-os/connectors-sdk";
import {
  apifyFailureStreak,
  apifySourceState,
  apifySpendToday,
  claimApifyRun,
  createApifyRun,
  failApifyRun,
  findMergeTarget,
  finishApifyRun,
  getApifyRunByApifyId,
  getApifySource,
  getQuarantineItem,
  resolveQuarantine,
  listApifySources,
  listOpenApifyRuns,
  observationState,
  quarantineItem,
  recordSourceOutcome,
  recordSourceRuns,
  saveObservation,
  setApifyRunStatus,
  setExpectedFields,
  setSourceStatus,
  sourceSpendToday,
  touchSupply,
  upsertSupply,
  type ApifyRunRow,
  type ApifySource,
  type RunCounts,
  type SourceActor,
} from "@opportunity-os/db";
import { detectInjection, isAdmissible } from "@opportunity-os/risk";
import { createLogger } from "@opportunity-os/observability";
import { FAILING_AFTER_ERRORS, SOURCE_POLICY_VERSION, healthFor, policyGaps, skipReason } from "./source-policy";

/**
 * Apify ingestion (PRD v2 FR-01, ADR-042). An actor source runs only while its
 * permission policy holds, within its interval, its daily cap and the global
 * Apify cap, never twice at once, and not before its backoff after a failure.
 * A finished run is ingested once (webhook or poll, whichever claims it):
 * each item mapped by the source's field map, checked like every connector
 * observation (category, prompt injection), deduplicated against what the
 * source sent before and merged with the same listing seen through another
 * source. Whatever does not fit goes to quarantine.
 */

const log = createLogger("intel:apify");

/** Items read from one run, whatever the source allows. */
export const MAX_ITEMS_PER_RUN = 1000;
const PAGE = 250;
/** First retry delay after a failed run; doubles per consecutive failure, at most a day. */
const BACKOFF_BASE_MINUTES = 15;

export function backoffUntil(streak: number, now: Date = new Date()): string {
  const minutes = Math.min(24 * 60, BACKOFF_BASE_MINUTES * 2 ** Math.max(0, streak - 1));
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** The supply source id an actor's listings are stored under. */
export const apifySupplySourceId = (registryId: string) => `apify:${registryId}`;

/** A canonical, admissible category for an observation, or null when it is unmapped (default deny, PRD §3.4). */
function admissibleCategory(label: unknown): string | null {
  const l = typeof label === "string" ? label : null;
  if (isAdmissible(l)) return l;
  const c = canonicalCategory(l);
  return isAdmissible(c) ? c : null;
}

export interface StoreResult {
  state: "new" | "changed" | "duplicate" | "merged";
  supplyId: string | null;
}

/**
 * Records one observation in the ledger and stores its listing: a duplicate
 * only refreshes "seen"; a listing first seen through another source is
 * merged into that one (provenance kept here); otherwise the supply row is
 * created or updated. Used by every source, so merges work both ways.
 */
export async function storeObservation(registryId: string, obs: RawObservation, canonicalKey: string | null, apifyRunId: string | null): Promise<StoreResult> {
  const prior = await observationState(registryId, obs.ref.external_id, obs.content_hash);
  const save = (supplyId: string | null, merged: boolean) =>
    saveObservation({ sourceId: registryId, apifyRunId, kind: obs.kind, externalId: obs.ref.external_id, canonicalKey, contentHash: obs.content_hash, content: obs.content, supplyId, merged });

  if (prior.state === "duplicate" || (prior.state === "changed" && prior.merged)) {
    if (prior.supplyId) await touchSupply(prior.supplyId);
    await save(prior.supplyId, prior.merged);
    return { state: prior.state === "duplicate" ? "duplicate" : "merged", supplyId: prior.supplyId };
  }
  if (obs.kind === "demand") {
    // Demand observations are kept as evidence; the demand pipeline reads its own sources.
    await save(null, false);
    return { state: prior.state, supplyId: null };
  }
  if (prior.state === "new") {
    const target = await findMergeTarget(canonicalKey, registryId);
    if (target) {
      await touchSupply(target);
      await save(target, true);
      return { state: "merged", supplyId: target };
    }
  }
  const n = normalizeObservation(obs);
  if (n.kind !== "supply") return { state: prior.state, supplyId: null };
  const { supplyId } = await upsertSupply({
    sourceId: n.source_id,
    externalRef: n.external_ref,
    title: n.title,
    description: n.description,
    category: n.category,
    priceMinor: n.price?.amount ?? null,
    currency: n.price?.currency ?? "USD",
    quantity: n.quantity,
    sourceReliability: n.source_reliability,
    listingUrl: n.uri,
    seller: n.seller,
    location: n.location,
    condition: n.condition,
  });
  await save(supplyId, false);
  return { state: prior.state, supplyId };
}

/**
 * Maps, checks and stores one dataset item; quarantines it when it does not
 * fit. `acceptUnexpected` when a person released it from quarantine.
 */
export async function ingestApifyItem(source: ApifySource, map: ApifyFieldMap, raw: unknown, runId: string | null, opts: { acceptUnexpected?: boolean } = {}): Promise<StoreResult["state"] | "quarantined"> {
  const m = mapApifyItem(apifySupplySourceId(source.id), raw, map, source.apify_expected_fields, opts);
  if (!m.ok) {
    await quarantineItem({ sourceId: source.id, apifyRunId: runId, externalId: m.externalId, reason: m.reason, fields: m.fields, item: raw });
    return "quarantined";
  }
  const obs = m.observation;
  const category = admissibleCategory(obs.content["category"]);
  if (obs.kind === "supply" && !category) {
    await quarantineItem({ sourceId: source.id, apifyRunId: runId, externalId: obs.ref.external_id, reason: "category_unmapped", fields: [String(obs.content["category"] ?? "(none)")], item: raw });
    return "quarantined";
  }
  const textOf = `${String(obs.content["title"] ?? "")} ${String(obs.content["description"] ?? "")}`;
  const injection = detectInjection(textOf);
  if (injection.length > 0) {
    await quarantineItem({ sourceId: source.id, apifyRunId: runId, externalId: obs.ref.external_id, reason: "prompt_injection", fields: injection.slice(0, 10), item: raw });
    return "quarantined";
  }
  obs.content["category"] = category;
  return (await storeObservation(source.id, obs, m.canonicalKey, runId)).state;
}

export interface ApifyDeps {
  client: ApifyClient;
  /** Public URL of POST /v1/webhooks/apify; with the secret, Apify calls it when a run ends. */
  webhook: { url: string; secret: string } | null;
  dailyBudgetUsd: number;
  now?: Date;
}

/** Why an actor source does not start a run now, or null with the spend cap for the run. */
export async function apifyStartDecision(source: ApifySource, deps: ApifyDeps, spent: { source: number; all: number }): Promise<{ skip: string } | { maxChargeUsd: number }> {
  const now = deps.now ?? new Date();
  const reason = skipReason(source, spent.source, now);
  if (reason) return { skip: reason };
  if (!("map" in parseFieldMap(source.apify_field_map))) return { skip: "invalid_field_map" };
  const state = await apifySourceState(source.id);
  if (state.open) return { skip: "run_in_progress" };
  if (state.retryAfter && Date.parse(state.retryAfter) > now.getTime()) return { skip: "backoff" };
  const caps = [deps.dailyBudgetUsd - spent.all, source.max_daily_usd !== null ? source.max_daily_usd - spent.source : Infinity, source.apify_max_charge_usd ?? Infinity];
  const maxChargeUsd = Math.min(...caps);
  if (!(maxChargeUsd >= 0.01)) return { skip: "daily_budget_reached" };
  return { maxChargeUsd: Math.round(maxChargeUsd * 10_000) / 10_000 };
}

/** Starts a run for every active actor source that is due. */
export async function startDueApifyRuns(deps: ApifyDeps): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const spendBySource = await sourceSpendToday();
  let spentAll = await apifySpendToday();
  for (const source of await listApifySources("active")) {
    const decision = await apifyStartDecision(source, deps, { source: spendBySource.get(source.id) ?? 0, all: spentAll });
    if ("skip" in decision) {
      out[source.id] = `skipped:${decision.skip}`;
      continue;
    }
    try {
      const run = await deps.client.startRun({
        actorId: source.apify_actor_id!,
        build: source.apify_actor_version!,
        input: source.apify_input ?? {},
        maxItems: Math.min(source.apify_max_items ?? MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_RUN),
        maxTotalChargeUsd: decision.maxChargeUsd,
        timeoutSecs: 3600,
        webhook: deps.webhook,
      });
      await createApifyRun(source.id, { apifyRunId: run.id, datasetId: run.defaultDatasetId ?? null, apifyStatus: run.status, maxChargeUsd: decision.maxChargeUsd });
      spentAll += decision.maxChargeUsd;
      out[source.id] = `started:${run.id}`;
    } catch (err) {
      // Could not even start (bad token, unknown actor, build not found): counts as a failure.
      await recordFailure(source, null, String(err), null, null, deps.now);
      out[source.id] = `start_failed:${String(err).slice(0, 120)}`;
    }
  }
  return out;
}

async function recordFailure(source: ApifySource, run: ApifyRunRow | null, error: string, apifyStatus: string | null, usageUsd: number | null, now: Date = new Date()) {
  const streak = (await apifyFailureStreak(source.id)) + 1;
  if (run) await failApifyRun(run.id, { apifyStatus, usageUsd, error, retryAfter: backoffUntil(streak, now) });
  else {
    // A start that failed leaves a run row too, so backoff and the streak see it.
    const placeholder = await createApifyRun(source.id, { apifyRunId: `start-failed:${source.id}:${now.getTime()}`, datasetId: null, apifyStatus: "NOT_STARTED", maxChargeUsd: 0 });
    await failApifyRun(placeholder.id, { apifyStatus: null, usageUsd: null, error, retryAfter: backoffUntil(streak, now) });
  }
  await recordSourceRuns([{ sourceId: source.id, intelRunId: null, query: `apify:${source.apify_actor_id}`, results: 0, newResults: 0, leads: 0, costUsd: usageUsd ?? 0, error: error.slice(0, 500) }]);
  const after = await recordSourceOutcome(source.id, false, healthFor);
  if (after && after.consecutive_failures >= FAILING_AFTER_ERRORS && after.status === "active") {
    await setSourceStatus(source.id, "paused", "failing", { type: "system", id: null }, { policyGaps: (s) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION });
  }
  log.warn({ sourceId: source.id, streak, error: error.slice(0, 200) }, "apify.run.failed");
}

export type ProcessOutcome = "unknown_run" | "still_running" | "already_handled" | "ingested" | "failed";

/**
 * Brings one of our runs up to date from Apify (never from a webhook body):
 * still running, failed (backoff, maybe pause), or finished and ingested by
 * whichever caller claims it first.
 */
export async function processApifyRun(apifyRunId: string, client: ApifyClient, now: Date = new Date()): Promise<{ outcome: ProcessOutcome; counts?: RunCounts }> {
  const row = await getApifyRunByApifyId(apifyRunId);
  if (!row) return { outcome: "unknown_run" };
  if (row.status === "succeeded" || row.status === "failed") return { outcome: "already_handled" };
  const source = await getApifySource(row.source_id);
  if (!source) return { outcome: "unknown_run" };
  let run: ApifyRun;
  try {
    run = await client.getRun(apifyRunId);
  } catch (err) {
    log.warn({ apifyRunId, err: String(err) }, "apify.run.lookup_failed");
    return { outcome: "still_running" };
  }
  if (!APIFY_TERMINAL.includes(run.status)) {
    if (run.status !== row.apify_status) await setApifyRunStatus(row.id, run.status);
    return { outcome: "still_running" };
  }
  const usage = typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null;
  if (run.status !== "SUCCEEDED") {
    if (!(await claimApifyRun(row.id, run.status, run.defaultDatasetId ?? null, usage))) return { outcome: "already_handled" };
    await recordFailure(source, row, `run ${run.status.toLowerCase()}${run.statusMessage ? `: ${run.statusMessage}` : ""}`, run.status, usage, now);
    return { outcome: "failed" };
  }
  if (!(await claimApifyRun(row.id, run.status, run.defaultDatasetId ?? null, usage))) return { outcome: "already_handled" };

  const parsed = parseFieldMap(source.apify_field_map);
  if (!("map" in parsed) || !run.defaultDatasetId) {
    await recordFailure(source, row, !run.defaultDatasetId ? "run has no dataset" : `invalid field map: ${"errors" in parsed ? parsed.errors.join("; ") : ""}`, run.status, usage, now);
    return { outcome: "failed" };
  }
  const counts: RunCounts = { total: 0, new: 0, changed: 0, duplicate: 0, merged: 0, quarantined: 0 };
  const limit = Math.min(source.apify_max_items ?? MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_RUN);
  // No expected fields yet: this first run sets them (the reviewer gave none).
  const learning = source.apify_expected_fields === null;
  const seenFields = new Set<string>();
  try {
    for (let offset = 0; offset < limit; offset += PAGE) {
      const items = await client.datasetItems(run.defaultDatasetId, offset, Math.min(PAGE, limit - offset));
      for (const item of items) {
        counts.total++;
        if (learning && item && typeof item === "object") for (const k of Object.keys(item)) seenFields.add(k);
        const state = await ingestApifyItem(source, parsed.map, item, row.id);
        counts[state === "quarantined" ? "quarantined" : state]++;
      }
      if (items.length < PAGE) break;
    }
  } catch (err) {
    await recordFailure(source, row, `ingest: ${String(err)}`, run.status, usage, now);
    return { outcome: "failed", counts };
  }
  if (learning && seenFields.size > 0) await setExpectedFields(source.id, [...seenFields]);
  await finishApifyRun(row.id, counts);
  await recordSourceRuns([{ sourceId: source.id, intelRunId: null, query: `apify:${source.apify_actor_id}`, results: counts.total, newResults: counts.new + counts.changed, leads: 0, costUsd: usage ?? 0, error: null }]);
  await recordSourceOutcome(source.id, true, healthFor);
  log.info({ sourceId: source.id, apifyRunId, ...counts, usageUsd: usage }, "apify.run.ingested");
  return { outcome: "ingested", counts };
}

/** The webhook's fallback: checks every open run. */
export async function pollApifyRuns(client: ApifyClient, now: Date = new Date()): Promise<Record<string, ProcessOutcome>> {
  const out: Record<string, ProcessOutcome> = {};
  for (const r of await listOpenApifyRuns()) out[r.apify_run_id] = (await processApifyRun(r.apify_run_id, client, now)).outcome;
  return out;
}

/** One sweep: finish what ran, then start what is due. */
export async function apifyCycle(deps: ApifyDeps) {
  const polled = await pollApifyRuns(deps.client, deps.now);
  const started = await startDueApifyRuns(deps);
  return { polled, started };
}

export class QuarantineError extends Error {
  constructor(readonly code: "not_found" | "not_pending" | "not_releasable" | "invalid_field_map") {
    super(code);
  }
}

/**
 * A person's decision on a quarantined item. Only an item held for unexpected
 * fields can be released (the others would fail the same check again):
 * released, it is ingested as it is; with `acceptFields`, those fields become
 * expected for the source so later items carrying them pass.
 */
export async function resolveQuarantinedItem(id: string, decision: "release" | "discard", actor: SourceActor, opts: { acceptFields?: boolean } = {}): Promise<{ status: "released" | "discarded"; ingested?: StoreResult["state"] | "quarantined" }> {
  const q = await getQuarantineItem(id);
  if (!q) throw new QuarantineError("not_found");
  if (q.status !== "pending") throw new QuarantineError("not_pending");
  if (decision === "discard") {
    if (!(await resolveQuarantine(id, "discarded", actor))) throw new QuarantineError("not_pending");
    return { status: "discarded" };
  }
  if (q.reason !== "unexpected_fields") throw new QuarantineError("not_releasable");
  const source = await getApifySource(q.source_id);
  const parsed = parseFieldMap(source?.apify_field_map);
  if (!source || !("map" in parsed)) throw new QuarantineError("invalid_field_map");
  if (!(await resolveQuarantine(id, "released", actor))) throw new QuarantineError("not_pending");
  if (opts.acceptFields) {
    const fields = [...(source.apify_expected_fields ?? []), ...q.fields];
    await setExpectedFields(source.id, fields);
    source.apify_expected_fields = fields;
  }
  return { status: "released", ingested: await ingestApifyItem(source, parsed.map, q.item, q.apify_run_id, { acceptUnexpected: true }) };
}
