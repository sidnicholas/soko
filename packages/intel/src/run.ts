import { createHash } from "node:crypto";
import type { SearchProvider, WebSearchResult } from "@opportunity-os/connectors-sdk";
import {
  countIntelRuns,
  createIntelRun,
  finishIntelRun,
  insertIntelLead,
  intelRunsStartedToday,
  intelSpentTodayUsd,
  knownIntelLeadHashes,
  expireDemandHypotheses,
  insertDemandHypothesis,
  listCounterpartDue,
  listDueHypotheses,
  recordHypothesisCheck,
  setLeadCounterparts,
  touchIntelLeadsSeen,
  type HypothesisCheck,
  type StoredCounterpart,
  listSources,
  listUnassessedIntelLeads,
  recordSourceOutcome,
  recordSourceRuns,
  setIntelLeadStatus,
  setSourceStatus,
  sourceQueryStats,
  sourceSpendToday,
  touchIntelSource,
  type RegistrySource,
  type SourceRunRecord,
  upsertIntelCandidate,
  type IntelRunTotals,
} from "@opportunity-os/db";
import { StructuredOutputError, type LlmGateway } from "@opportunity-os/llm-gateway";
import { detectInjection } from "@opportunity-os/risk";
import { createLogger } from "@opportunity-os/observability";
import { SpendBudget } from "./budget";
import {
  ASSESSMENT_SYSTEM,
  AssessmentSchema,
  AssessmentWire,
  DETECTION_SYSTEM,
  DetectionSchema,
  DetectionWire,
  assessmentPrompt,
  detectionPrompt,
  type Assessment,
  type Detection,
} from "./prompts";
import { poolFromSources, stageOneQueries, type StageOneQuery } from "./queries";
import { SOURCE_POLICY_VERSION, healthFor, isUnproductive, policyGaps, skipReason } from "./source-policy";
import { capForEvidence, counterpartOutcome, hypothesisSchedule, laneKinds, laneOrientations, routeSignal, titleFlags, type Lane } from "./intelligence";
import {
  bucketFor,
  confidenceFor,
  expectedValue,
  fraudFlags,
  freshnessScore,
  isGovernmentProcurement,
  isNoLeadHost,
  mergeFlags,
  monetizationResolved,
  regulatoryFlags,
  scoreCandidate,
  verificationStatus,
  type ContactPath,
  type Urgency,
} from "./rules";
import { serviceByKey } from "./services";

const log = createLogger("intel");

export interface IntelRunOptions {
  search: SearchProvider;
  llm: LlmGateway;
  dailyBudgetUsd: number;
  /** Scheduled runs per UTC day; each gets an equal share, unused share rolls forward. */
  runsPerDay: number;
  queriesPerRun: number;
  maxAssessments: number;
  /** Conservative per-call estimates used to stop before overspending. */
  estimates?: { detectionUsd: number; assessmentUsd: number };
  /** Which side this run serves (PRD v2 FR-02/FR-03): demand (demand + problem), supply, or both. */
  lane?: Lane;
  /** Targeted searches for the other side per run: suppliers for demand, buyers for supply. */
  counterpartSearches?: number;
  /** Watchlist hypotheses revisited per run (demand lane). */
  hypothesisChecks?: number;
}

export interface IntelRunResult extends IntelRunTotals {
  runId: string;
}

const DEFAULT_ESTIMATES = { detectionUsd: 0.02, assessmentUsd: 0.08 };
const DEFAULT_COUNTERPART_SEARCHES = 4;
const DEFAULT_HYPOTHESIS_CHECKS = 2;
const MIN_HYPOTHESIS_CONFIDENCE = 0.3;
const MIN_CREDIBILITY = 0.4;
/** Unassessed leads older than this aren't worth a paid assessment. */
const CARRY_OVER_DAYS = 7;
const CARRY_OVER_LIMIT = 30;
const STALE_FRESHNESS = 0.1;

/** A lead ready for assessment — found this run, or carried over from an earlier one. */
interface AssessableLead {
  leadId: string;
  kind: "demand" | "supply" | "problem";
  title: string;
  summary: string;
  url: string;
  hostname: string;
  /** Search snippet when found this run; the stored summary for carried-over leads. */
  snippet: string;
  publishedAt: string | null;
  urgency: Urgency;
  credibility: number;
  contact: unknown;
  facts: unknown;
  oppositeQueries: string[];
  carriedOver: boolean;
  signalType: string | null;
  evidenceLevel: "observed" | "inferred";
  titleUnverified: boolean;
  /** Stored results of the counterpart search (other side), reused by assessment. */
  counterparts: StoredCounterpart[];
}

/**
 * Pacing: run k of the UTC day may spend up to k × (daily cap / runs per day)
 * minus what today's earlier runs spent, so the first run can't starve the
 * last, and a cheap run leaves its unused share to the next. Never more than
 * what is left of the daily cap.
 */
export function runAllowanceUsd(input: { dailyBudgetUsd: number; runsPerDay: number; spentTodayUsd: number; runsStartedToday: number }): number {
  const share = input.dailyBudgetUsd / Math.max(1, input.runsPerDay);
  const k = input.runsStartedToday + 1;
  const left = input.dailyBudgetUsd - input.spentTodayUsd;
  return Math.max(0, Math.min(left, share * k - input.spentTodayUsd));
}

function urlHash(url: string): string {
  const u = url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(u, "utf8").digest("hex");
}

/**
 * One AIOOS sweep (master prompt §31 vertical slice):
 * internet signal → lead detection → opposite-side discovery → verification →
 * economics → why-paid test → contact path → action-queue candidate.
 * Every paid call is checked against today's remaining allowance first.
 */
export async function runIntelCycle(opts: IntelRunOptions): Promise<IntelRunResult> {
  const est = opts.estimates ?? DEFAULT_ESTIMATES;
  const [spentTodayUsd, runsStartedToday, runIndex] = await Promise.all([intelSpentTodayUsd(), intelRunsStartedToday(), countIntelRuns()]);
  const allowance = runAllowanceUsd({ dailyBudgetUsd: opts.dailyBudgetUsd, runsPerDay: opts.runsPerDay, spentTodayUsd, runsStartedToday });
  const budget = new SpendBudget(allowance);
  const lane: Lane = opts.lane ?? "all";
  const kinds = laneKinds(lane);
  const runId = await createIntelRun(lane);
  const notes: Record<string, unknown> = { lane, allowanceUsd: allowance, spentTodayAtStartUsd: spentTodayUsd, queries: [] as unknown[], errors: [] as string[], hypothesesCreated: 0 };
  const errors = notes.errors as string[];
  let exhausted = false;
  let leadsFound = 0;
  // One record per search, written to source_runs when the run ends (PRD v2 FR-01).
  const sourceRuns: SourceRunRecord[] = [];

  try {
    // ---- Stage 1-2: broad discovery + detection, from the sources the registry clears for this run
    const { pool: queryPool, skipped } = await runnablePool(lane);
    notes.sources = { runnable: new Set(queryPool.map((q) => q.sourceId)).size, skipped };
    for (const q of stageOneQueries(runIndex, opts.queriesPerRun, queryPool)) {
      if (!budget.canSpend(opts.search.costPerQueryUsd + est.detectionUsd)) {
        exhausted = true;
        break;
      }
      let results: WebSearchResult[];
      const spentBefore = budget.spentUsd;
      const record: SourceRunRecord = { sourceId: q.sourceId ?? null, intelRunId: runId, query: q.query, results: 0, newResults: 0, leads: 0, costUsd: 0, error: null };
      sourceRuns.push(record);
      try {
        results = await opts.search.search({ query: q.query, count: 10, freshness: q.freshness });
      } catch (err) {
        errors.push(`search "${q.query}": ${String(err)}`);
        budget.recordSearch(opts.search.costPerQueryUsd);
        record.error = String(err).slice(0, 500);
        record.costUsd = budget.spentUsd - spentBefore;
        if (q.sourceId) await recordSourceOutcome(q.sourceId, false, healthFor);
        continue;
      }
      budget.recordSearch(opts.search.costPerQueryUsd);
      if (q.sourceId) await recordSourceOutcome(q.sourceId, true, healthFor);
      const known = await knownIntelLeadHashes(results.map((r) => urlHash(r.url)));
      await touchIntelLeadsSeen([...known]);
      const unseen = results.filter((r) => !known.has(urlHash(r.url)) && detectInjection(`${r.title} ${r.snippet}`).length === 0);
      const fresh = unseen.filter((r) => !isNoLeadHost(r.hostname));
      const queryNote: Record<string, unknown> = { q: q.query, results: results.length, new: fresh.length, noLeadHost: unseen.length - fresh.length, leads: 0, kept: 0, reasons: {} };
      (notes.queries as unknown[]).push(queryNote);
      record.results = results.length;
      record.newResults = fresh.length;
      record.costUsd = budget.spentUsd - spentBefore;
      if (fresh.length === 0) continue;

      let detection: Detection;
      try {
        const { prompt, untrusted } = detectionPrompt(q.query, fresh);
        const res = await opts.llm.runStructured({ taskClass: "extraction", system: DETECTION_SYSTEM, prompt, untrustedContext: untrusted }, DetectionSchema, { outputSchema: DetectionWire });
        budget.recordLlm(res.telemetry.usd);
        record.costUsd = budget.spentUsd - spentBefore;
        detection = res.value;
      } catch (err) {
        // A reply that never parsed was still billed: keep the ledger honest.
        if (err instanceof StructuredOutputError) budget.recordLlm(err.telemetry.usd);
        else throw modelUnavailable(err);
        record.costUsd = budget.spentUsd - spentBefore;
        errors.push(`detect "${q.query}": ${String(err).slice(0, 200)}`);
        continue;
      }

      const reasons: Record<string, number> = {};
      for (const s of detection.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      queryNote.reasons = reasons;
      queryNote.leads = detection.leads.length;
      for (const lead of detection.leads) {
        const result = fresh[lead.index];
        if (!result) continue;
        if (lead.credibility < MIN_CREDIBILITY) {
          reasons.low_credibility = (reasons.low_credibility ?? 0) + 1;
          continue;
        }
        // Demand the party did not state itself goes to the watchlist, never the lead table.
        if (routeSignal(lead.kind, lead.evidence_level) === "hypothesis") {
          if (await storeHypothesis(runId, q.query, result, { signal_type: lead.signal_type, hypothesis: lead.title, basis: lead.summary, item: lead.item, location: lead.location, confidence: lead.credibility, check_query: lead.opposite_queries[0] ?? null, revisit_days: 14, facts: lead.facts })) {
            notes.hypothesesCreated = (notes.hypothesesCreated as number) + 1;
          }
          continue;
        }
        const leadId = await insertIntelLead({
          runId,
          kind: lead.kind,
          title: lead.title,
          summary: lead.summary,
          url: result.url,
          urlHash: urlHash(result.url),
          hostname: result.hostname,
          query: q.query,
          searchProvider: result.provider,
          publishedAt: result.publishedAt,
          ageText: result.ageText,
          item: lead.item,
          category: lead.category,
          quantity: lead.quantity,
          location: lead.location,
          deadline: lead.deadline,
          priceMinor: typeof lead.price_usd === "number" ? Math.round(lead.price_usd * 100) : null,
          currency: typeof lead.price_usd === "number" ? "USD" : null,
          urgency: lead.urgency,
          credibility: lead.credibility,
          contact: lead.contact,
          facts: lead.facts,
          oppositeQueries: lead.opposite_queries,
          signalType: lead.signal_type,
          evidenceLevel: lead.evidence_level,
          supplyTerms: lead.kind === "supply" ? lead.supply_terms : {},
          titleUnverified: lead.title_unverified,
        });
        if (!leadId) continue;
        leadsFound++;
        queryNote.kept = (queryNote.kept as number) + 1;
        record.leads++;
        await touchIntelSource(result.hostname, lead.kind, { leads: 1 });
      }
      // Implied demand the model listed as hypotheses (hiring, a new project, …).
      for (const h of detection.hypotheses) {
        const result = fresh[h.index];
        if (!result || h.confidence < MIN_HYPOTHESIS_CONFIDENCE) continue;
        if (await storeHypothesis(runId, q.query, result, h)) notes.hypothesesCreated = (notes.hypothesesCreated as number) + 1;
      }
    }

    // ---- Counterpart discovery (FR-03): unmet demand → targeted supplier search,
    // unmatched supply → buyer search. Results are stored on the lead and reused
    // by assessment, so the other side is searched once, not per assessment.
    const counterpartDue = await listCounterpartDue({ kinds, sinceDays: CARRY_OVER_DAYS, limit: opts.counterpartSearches ?? DEFAULT_COUNTERPART_SEARCHES });
    let counterpartSearches = 0;
    for (const lead of counterpartDue) {
      const queries = Array.isArray(lead.opposite_queries) ? (lead.opposite_queries as string[]) : [];
      // Screened before assessment anyway: never pay to search its other side.
      if (queries.length === 0 || isGovernmentProcurement(lead.hostname)) {
        await setLeadCounterparts(lead.id, { status: "not_needed", attempts: lead.counterpart_attempts, nextAt: null, counterparts: [] });
        continue;
      }
      if (!budget.canSpend(opts.search.costPerQueryUsd)) {
        exhausted = true;
        break;
      }
      const query = queries[lead.counterpart_attempts % queries.length]!;
      const record: SourceRunRecord = { sourceId: null, intelRunId: runId, query, results: 0, newResults: 0, leads: 0, costUsd: opts.search.costPerQueryUsd, error: null };
      sourceRuns.push(record);
      let found: WebSearchResult[] = [];
      try {
        found = await opts.search.search({ query, count: 5, freshness: "month" });
      } catch (err) {
        errors.push(`counterpart "${query}": ${String(err)}`);
        record.error = String(err).slice(0, 500);
      }
      budget.recordSearch(opts.search.costPerQueryUsd);
      counterpartSearches++;
      const usable = found.filter((r) => detectInjection(`${r.title} ${r.snippet}`).length === 0 && !isNoLeadHost(r.hostname));
      record.results = found.length;
      record.newResults = usable.length;
      if (record.error) continue;
      const outcome = counterpartOutcome(usable.length, lead.counterpart_attempts);
      await setLeadCounterparts(lead.id, {
        ...outcome,
        counterparts: usable.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet, hostname: r.hostname, publishedAt: r.publishedAt, query })),
      });
    }
    notes.counterpartSearches = counterpartSearches;

    // ---- Watchlist (FR-03): expire hypotheses past their lifetime, revisit the due ones.
    if (kinds.includes("demand") && !exhausted) {
      notes.hypothesesExpired = await expireDemandHypotheses();
      const confirmed = await revisitHypotheses(runId, opts, est, budget, sourceRuns, errors);
      notes.hypothesesConfirmed = confirmed.confirmed;
      leadsFound += confirmed.leads;
      if (confirmed.exhausted) exhausted = true;
    }

    // ---- Stage 3-6: verification, economics, why-paid, contact → candidate.
    // Pool = unassessed leads of this lane, this run's and recent ones, past their counterpart search.
    const carried = (await listUnassessedIntelLeads({ sinceDays: CARRY_OVER_DAYS, limit: CARRY_OVER_LIMIT, excludeIds: [], kinds })).map(
      (l): AssessableLead => ({
        leadId: l.id,
        kind: l.kind as AssessableLead["kind"],
        title: l.title,
        summary: l.summary,
        url: l.url,
        hostname: l.hostname,
        snippet: l.summary,
        publishedAt: l.published_at,
        urgency: (l.urgency ?? "medium") as Urgency,
        credibility: Number(l.credibility),
        contact: l.contact,
        facts: l.facts,
        oppositeQueries: Array.isArray(l.opposite_queries) ? (l.opposite_queries as string[]) : [],
        carriedOver: l.run_id !== runId,
        signalType: l.signal_type,
        evidenceLevel: l.evidence_level === "inferred" ? "inferred" : "observed",
        titleUnverified: l.title_unverified,
        counterparts: Array.isArray(l.counterparts) ? (l.counterparts as StoredCounterpart[]) : [],
      }),
    );
    const urgencyWeight = { high: 1, medium: 0.8, low: 0.6 } as const;
    // A lead with the other side already found is a two-sided match: assess it first.
    const priority = (l: AssessableLead) => l.credibility * urgencyWeight[l.urgency] * freshnessScore(l.publishedAt, l.urgency) * (l.counterparts.length > 0 ? 1.5 : 1);
    const pool: AssessableLead[] = [];
    for (const l of carried) {
      // Decayed past usefulness: retire it rather than pay to assess it.
      if (freshnessScore(l.publishedAt, l.urgency) < STALE_FRESHNESS) await setIntelLeadStatus(l.leadId, "skipped");
      else pool.push(l);
    }
    const ranked = pool.sort((a, b) => priority(b) - priority(a));
    notes.assessmentPool = { thisRun: carried.filter((l) => !l.carriedOver).length, carriedOver: carried.filter((l) => l.carriedOver).length, eligible: ranked.length };
    let candidates = 0;
    let carriedAssessed = 0;
    // Government procurement never needs a paid assessment to reject — screen it
    // out of the pool first so it can't take the limited assessment slots.
    const screened = ranked.filter((l) => isGovernmentProcurement(l.hostname));
    for (const lead of screened) {
      await persistScreenedCandidate(runId, lead, "federal_procurement", "Government procurement notice: responding needs contractor registration (SAM), clearances or the ability to supply directly — not reachable with near-zero capital. Screened without a paid assessment.");
      await setIntelLeadStatus(lead.leadId, "assessed");
    }
    (notes.assessmentPool as Record<string, number>).screenedFederal = screened.length;
    const assessable = ranked.filter((l) => !isGovernmentProcurement(l.hostname));
    for (const lead of assessable.slice(0, opts.maxAssessments)) {
      // The other side, as the counterpart search stored it.
      const counter: WebSearchResult[] = lead.counterparts.map((c) => ({ url: c.url, title: c.title, snippet: c.snippet, hostname: c.hostname, publishedAt: c.publishedAt, ageText: null, provider: "counterpart_search" }));
      if (!budget.canSpend(est.assessmentUsd)) {
        exhausted = true;
        break;
      }
      let a: Assessment;
      try {
        const { prompt, untrusted } = assessmentPrompt(
          { kind: lead.kind, title: lead.title, summary: lead.summary, url: lead.url, publishedAt: lead.publishedAt, facts: lead.facts, contact: lead.contact },
          counter,
        );
        const res = await opts.llm.runStructured({ taskClass: "research_synthesis", system: ASSESSMENT_SYSTEM, prompt, untrustedContext: untrusted }, AssessmentSchema, { outputSchema: AssessmentWire });
        budget.recordLlm(res.telemetry.usd);
        a = res.value;
      } catch (err) {
        if (err instanceof StructuredOutputError) budget.recordLlm(err.telemetry.usd);
        else throw modelUnavailable(err);
        errors.push(`assess ${lead.url}: ${String(err).slice(0, 200)}`);
        continue;
      }

      const bucket = await persistCandidate(runId, lead, counter, a);
      await setIntelLeadStatus(lead.leadId, "assessed");
      if (bucket === "act_now" || bucket === "verify_next") await touchIntelSource(lead.hostname, lead.kind, { actionable: 1 });
      candidates++;
      if (lead.carriedOver) carriedAssessed++;
    }
    (notes.assessmentPool as Record<string, number>).assessed = candidates;
    (notes.assessmentPool as Record<string, number>).carriedOverAssessed = carriedAssessed;

    const totals: IntelRunTotals = {
      status: exhausted ? "budget_exhausted" : "completed",
      searchCalls: budget.searchCalls,
      llmCalls: budget.llmCalls,
      searchUsd: budget.searchUsd,
      llmUsd: budget.llmUsd,
      leadsFound,
      candidates,
      notes,
    };
    await finishIntelRun(runId, totals);
    await flushSourceRuns(sourceRuns);
    await pauseUnproductiveSources();
    log.info({ runId, ...totals, notes: undefined, errors: errors.length }, "intel.run.complete");
    return { runId, ...totals };
  } catch (err) {
    const totals: IntelRunTotals = {
      status: "failed",
      searchCalls: budget.searchCalls,
      llmCalls: budget.llmCalls,
      searchUsd: budget.searchUsd,
      llmUsd: budget.llmUsd,
      leadsFound,
      candidates: 0,
      notes: { ...notes, fatal: String(err) },
    };
    await finishIntelRun(runId, totals);
    await flushSourceRuns(sourceRuns);
    throw err;
  }
}

/**
 * Every model provider failed (outage, revoked key, no credit), as opposed to
 * a reply that did not parse. Stops the run: the remaining searches would be
 * paid for and discarded. The run is recorded as failed and the worker exits
 * non-zero, so the cron shows the failure.
 */
function modelUnavailable(err: unknown): Error {
  return new Error(`model provider unavailable; run stopped before further spend: ${String(err).slice(0, 300)}`);
}

const SYSTEM = { type: "system" as const, id: null };
const POLICY = { policyGaps: (s: RegistrySource) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION };

/**
 * The stage-1 pool for this run: active search venues that pass their
 * permission policy, minimum interval and daily budget (source-policy.ts). An
 * active source whose policy no longer holds (an expired review) is paused,
 * with an event, rather than silently skipped forever.
 */
async function runnablePool(lane: Lane): Promise<{ pool: StageOneQuery[]; skipped: Record<string, number> }> {
  const orientations = laneOrientations(lane);
  const [active, spend] = await Promise.all([listSources({ kind: "search_venue", status: "active" }), sourceSpendToday()]);
  const runnable: RegistrySource[] = [];
  const skipped: Record<string, number> = {};
  for (const s of active) {
    if (!orientations.includes(s.orientation)) continue;
    const why = skipReason(s, spend.get(s.id) ?? 0);
    if (why === null) {
      runnable.push(s);
      continue;
    }
    skipped[why] = (skipped[why] ?? 0) + 1;
    if (policyGaps(s).length > 0) {
      await setSourceStatus(s.id, "paused", why, SYSTEM, POLICY);
      log.info({ domain: s.domain, orientation: s.orientation, reason: why }, "intel.source.paused_policy");
    }
  }
  return { pool: poolFromSources(runnable), skipped };
}

interface HypothesisDraft {
  signal_type: string;
  hypothesis: string;
  basis: string;
  item: string | null;
  location: string | null;
  confidence: number;
  check_query: string | null;
  revisit_days: number;
  facts: unknown[];
}

/** Puts implied demand on the watchlist (deduped by source page). True when it was new. */
async function storeHypothesis(runId: string, query: string, result: WebSearchResult, h: HypothesisDraft): Promise<boolean> {
  const { revisitAt, expiresAt } = hypothesisSchedule(h.revisit_days);
  const id = await insertDemandHypothesis({
    runId,
    signalType: h.signal_type,
    hypothesis: h.hypothesis,
    basis: h.basis,
    evidence: [{ url: result.url, title: result.title, snippet: result.snippet, publishedAt: result.publishedAt, facts: h.facts }],
    sourceUrl: result.url,
    sourceUrlHash: urlHash(result.url),
    hostname: result.hostname,
    query,
    item: h.item,
    location: h.location,
    confidence: h.confidence,
    checkQuery: h.check_query,
    revisitDays: Math.min(60, Math.max(3, Math.round(h.revisit_days))),
    revisitAt,
    expiresAt,
  });
  return id !== null;
}

/**
 * Revisits due hypotheses: one search for the demand becoming explicit, and a
 * detection pass over what is new. An observed demand lead found that way
 * confirms the hypothesis (and is stored as a lead); otherwise the next
 * revisit is scheduled.
 */
async function revisitHypotheses(
  runId: string,
  opts: IntelRunOptions,
  est: { detectionUsd: number },
  budget: SpendBudget,
  sourceRuns: SourceRunRecord[],
  errors: string[],
): Promise<{ confirmed: number; leads: number; exhausted: boolean }> {
  let confirmed = 0;
  let leads = 0;
  for (const h of await listDueHypotheses(opts.hypothesisChecks ?? DEFAULT_HYPOTHESIS_CHECKS)) {
    if (!budget.canSpend(opts.search.costPerQueryUsd + est.detectionUsd)) return { confirmed, leads, exhausted: true };
    const query = h.check_query!;
    const spentBefore = budget.spentUsd;
    const record: SourceRunRecord = { sourceId: null, intelRunId: runId, query, results: 0, newResults: 0, leads: 0, costUsd: 0, error: null };
    sourceRuns.push(record);
    const next = new Date(Date.now() + h.revisit_days * 86_400_000).toISOString();
    const check: HypothesisCheck = { at: new Date().toISOString(), query, results: 0, outcome: "not_yet" };
    let results: WebSearchResult[] = [];
    try {
      results = await opts.search.search({ query, count: 10, freshness: "month" });
    } catch (err) {
      errors.push(`hypothesis "${query}": ${String(err)}`);
      record.error = String(err).slice(0, 500);
      budget.recordSearch(opts.search.costPerQueryUsd);
      record.costUsd = budget.spentUsd - spentBefore;
      await recordHypothesisCheck(h.id, { ...check, outcome: "error", note: record.error }, next);
      continue;
    }
    budget.recordSearch(opts.search.costPerQueryUsd);
    const known = await knownIntelLeadHashes(results.map((r) => urlHash(r.url)));
    const fresh = results.filter((r) => !known.has(urlHash(r.url)) && detectInjection(`${r.title} ${r.snippet}`).length === 0 && !isNoLeadHost(r.hostname));
    record.results = results.length;
    record.newResults = fresh.length;
    check.results = results.length;
    if (fresh.length > 0) {
      let detection: Detection | null = null;
      try {
        const { prompt, untrusted } = detectionPrompt(query, fresh);
        const res = await opts.llm.runStructured({ taskClass: "extraction", system: DETECTION_SYSTEM, prompt, untrustedContext: untrusted }, DetectionSchema, { outputSchema: DetectionWire });
        budget.recordLlm(res.telemetry.usd);
        detection = res.value;
      } catch (err) {
        if (err instanceof StructuredOutputError) budget.recordLlm(err.telemetry.usd);
        else throw modelUnavailable(err);
        errors.push(`hypothesis detect "${query}": ${String(err).slice(0, 200)}`);
      }
      // Only demand the party itself states confirms a hypothesis.
      const observed = (detection?.leads ?? []).find((l) => l.kind !== "supply" && l.evidence_level === "observed" && l.credibility >= MIN_CREDIBILITY && fresh[l.index]);
      if (observed) {
        const result = fresh[observed.index]!;
        const leadId = await insertIntelLead({
          runId,
          kind: observed.kind,
          title: observed.title,
          summary: observed.summary,
          url: result.url,
          urlHash: urlHash(result.url),
          hostname: result.hostname,
          query,
          searchProvider: result.provider,
          publishedAt: result.publishedAt,
          ageText: result.ageText,
          item: observed.item,
          category: observed.category,
          quantity: observed.quantity,
          location: observed.location,
          deadline: observed.deadline,
          priceMinor: typeof observed.price_usd === "number" ? Math.round(observed.price_usd * 100) : null,
          currency: typeof observed.price_usd === "number" ? "USD" : null,
          urgency: observed.urgency,
          credibility: observed.credibility,
          contact: observed.contact,
          facts: observed.facts,
          oppositeQueries: observed.opposite_queries,
          signalType: observed.signal_type,
          evidenceLevel: "observed",
          titleUnverified: false,
        });
        if (leadId) {
          check.outcome = "confirmed";
          check.leadId = leadId;
          record.leads++;
          leads++;
          confirmed++;
        }
      }
    }
    record.costUsd = budget.spentUsd - spentBefore;
    await recordHypothesisCheck(h.id, check, next);
  }
  return { confirmed, leads, exhausted: false };
}

/** Writes the run's per-search records. Never fails a run. */
async function flushSourceRuns(runs: SourceRunRecord[]): Promise<void> {
  try {
    await recordSourceRuns(runs);
  } catch (err) {
    log.warn({ err: String(err) }, "intel.source_runs.write_failed");
  }
}

/**
 * Pauses active search venues that keep failing, or that every query of has
 * been searched repeatedly without one lead. Built-in venues included. Runs
 * after the ledger is closed; never fails a run.
 */
async function pauseUnproductiveSources(): Promise<void> {
  try {
    const active = await listSources({ kind: "search_venue", status: "active" });
    if (active.length === 0) return;
    const stats = await sourceQueryStats();
    for (const source of active) {
      const reason =
        source.health === "failing" ? "failing_repeatedly" : isUnproductive(poolFromSources([source]).map((q) => q.query), stats) ? "no_leads_after_repeated_searches" : null;
      if (!reason) continue;
      await setSourceStatus(source.id, "paused", reason, SYSTEM, POLICY);
      log.info({ domain: source.domain, orientation: source.orientation, reason }, "intel.source.paused");
    }
  } catch (err) {
    log.warn({ err: String(err) }, "intel.source.pause_check_failed");
  }
}

/** Applies the deterministic decision layer to one assessment and stores the candidate. */
async function persistCandidate(runId: string, lead: AssessableLead, counter: WebSearchResult[], a: Assessment) {
  const service = lead.kind === "problem" ? serviceByKey(a.service_key) : undefined;
  const counterResult = a.counter_index !== null ? counter[a.counter_index] : undefined;
  const counterpartyFound = a.counterparty_found && (lead.kind === "problem" ? service !== undefined : counterResult !== undefined);

  const freshness = freshnessScore(lead.publishedAt, lead.urgency);
  const contact = (a.contact ?? lead.contact ?? null) as ContactPath | null;
  const screenText = [lead.title, lead.summary, lead.snippet, counterResult?.snippet ?? ""].join(" ");
  // Liquidation / distressed stock: clear title is never assumed (FR-02).
  const regulatory = mergeFlags(a.regulatory, regulatoryFlags(screenText), titleFlags({ kind: lead.kind, signalType: lead.signalType, titleUnverified: lead.titleUnverified, text: screenText }));
  const fraud = mergeFlags(a.fraud, fraudFlags(screenText));
  const monetization = { payer: a.monetization.payer, mechanism: a.monetization.mechanism, timing: a.monetization.timing, valueAdded: a.monetization.value_added };
  const resolved = monetizationResolved(monetization);
  const verification = verificationStatus({ evidence: a.evidence, publishedAt: lead.publishedAt, freshness, contact, counterpartyFound });
  const ev = expectedValue({ compensationUsd: a.economics.user_compensation_usd, probability: a.probability, freshness, resolved, fraud: fraud.length > 0 });
  const scoreInput = {
    ev,
    verification,
    freshness,
    contact,
    resolved,
    capitalUsd: a.economics.capital_required_usd,
    timeHours: a.economics.time_hours,
    regulatory,
    fraud,
  };
  const { score, factors } = scoreCandidate(scoreInput);
  // Inferred signals stop at WATCH with no outreach draft: evidence before outbound claims (FR-03).
  const { bucket, rejectReason, suppressOutreach } = capForEvidence(
    lead.kind,
    lead.evidenceLevel,
    bucketFor({
      ...scoreInput,
      compensationHighUsd: Math.max(...a.economics.user_compensation_usd),
      competitorOffer: a.lead_is_competitor_offer,
    }),
  );
  const matchKind = lead.kind === "problem" ? "problem_to_service" : lead.kind === "demand" ? "demand_to_supply" : "supply_to_demand";

  await upsertIntelCandidate({
    runId,
    leadId: lead.leadId,
    counterUrl: counterResult?.url ?? null,
    counterSummary: counterResult ? `${counterResult.title} — ${counterResult.snippet}`.slice(0, 600) : service ? service.name : null,
    serviceKey: service?.key ?? null,
    matchKind,
    title: a.title,
    matchRationale: a.match_rationale,
    verificationStatus: verification,
    freshness,
    economics: { ...a.economics, label: "estimate" },
    monetization: { ...monetization, resolved, label: resolved ? "inference" : "unknown", note: resolved ? null : "Potential match — monetization unresolved" },
    regulatoryFlags: regulatory,
    fraudFlags: fraud,
    contact,
    evLowUsd: ev[0],
    evHighUsd: ev[1],
    confidence: confidenceFor(verification, a.probability),
    score,
    explanation: { factors, modelFactors: a.factors, invalidators: a.invalidators, probability: a.probability },
    outreach: suppressOutreach
      ? { primary: null, secondary: null, requiresApproval: true, note: "Inferred, not stated by the party: confirm the signal before any outreach." }
      : { primary: a.outreach.primary, secondary: a.outreach.secondary, requiresApproval: true },
    bucket,
    rejectReason: rejectReason ?? (counterpartyFound ? null : "no_counterparty_found"),
  });
  return bucket;
}

/** Stores a lead rejected by a deterministic screen, without a paid model call. */
async function persistScreenedCandidate(runId: string, lead: AssessableLead, reason: "federal_procurement", rationale: string) {
  await upsertIntelCandidate({
    runId,
    leadId: lead.leadId,
    counterUrl: null,
    counterSummary: null,
    serviceKey: null,
    matchKind: lead.kind === "problem" ? "problem_to_service" : lead.kind === "demand" ? "demand_to_supply" : "supply_to_demand",
    title: lead.title,
    matchRationale: rationale,
    verificationStatus: "speculative",
    freshness: freshnessScore(lead.publishedAt, lead.urgency),
    economics: { gross_transaction_usd: null, costs_usd: null, user_compensation_usd: [0, 0], capital_required_usd: 0, time_hours: [0, 0], notes: "Not assessed (screened).", label: "unknown" },
    monetization: { payer: null, mechanism: null, timing: null, valueAdded: null, resolved: false, label: "unknown", note: "Screened before assessment" },
    regulatoryFlags: [{ flag: "government_contracting", reason: "Federal contractor registration / clearances required" }],
    fraudFlags: [],
    contact: lead.contact ?? null,
    evLowUsd: 0,
    evHighUsd: 0,
    confidence: "low",
    score: 0,
    explanation: { factors: [], modelFactors: [], invalidators: [], probability: [0, 0], screened: reason },
    outreach: { primary: null, secondary: null, requiresApproval: true },
    bucket: "rejected",
    rejectReason: reason,
  });
}
