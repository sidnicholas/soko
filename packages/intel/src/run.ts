import { createHash } from "node:crypto";
import type { SearchProvider, WebSearchResult } from "@opportunity-os/connectors-sdk";
import {
  countIntelRuns,
  createIntelRun,
  finishIntelRun,
  insertIntelLead,
  intelSpentTodayUsd,
  knownIntelLeadHashes,
  setIntelLeadStatus,
  touchIntelSource,
  upsertIntelCandidate,
  type IntelRunTotals,
} from "@opportunity-os/db";
import type { LlmGateway } from "@opportunity-os/llm-gateway";
import { detectInjection } from "@opportunity-os/risk";
import { createLogger } from "@opportunity-os/observability";
import { SpendBudget } from "./budget";
import {
  ASSESSMENT_SYSTEM,
  AssessmentSchema,
  DETECTION_SYSTEM,
  DetectionSchema,
  assessmentPrompt,
  detectionPrompt,
  type Assessment,
  type Detection,
} from "./prompts";
import { stageOneQueries } from "./queries";
import {
  bucketFor,
  confidenceFor,
  expectedValue,
  fraudFlags,
  freshnessScore,
  mergeFlags,
  monetizationResolved,
  regulatoryFlags,
  scoreCandidate,
  verificationStatus,
  type ContactPath,
} from "./rules";
import { serviceByKey } from "./services";

const log = createLogger("intel");

export interface IntelRunOptions {
  search: SearchProvider;
  llm: LlmGateway;
  dailyBudgetUsd: number;
  queriesPerRun: number;
  maxAssessments: number;
  /** Conservative per-call estimates used to stop before overspending. */
  estimates?: { detectionUsd: number; assessmentUsd: number };
}

export interface IntelRunResult extends IntelRunTotals {
  runId: string;
}

const DEFAULT_ESTIMATES = { detectionUsd: 0.02, assessmentUsd: 0.08 };
const MIN_CREDIBILITY = 0.4;

type DetectedLead = Detection["leads"][number] & { result: WebSearchResult; query: string; leadId: string };

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
  const remaining = Math.max(0, opts.dailyBudgetUsd - (await intelSpentTodayUsd()));
  const budget = new SpendBudget(remaining);
  const runIndex = await countIntelRuns();
  const runId = await createIntelRun();
  const notes: Record<string, unknown> = { remainingAtStartUsd: remaining, queries: [] as unknown[], errors: [] as string[] };
  const errors = notes.errors as string[];
  let exhausted = false;
  const detected: DetectedLead[] = [];

  try {
    // ---- Stage 1-2: broad discovery + detection
    for (const q of stageOneQueries(runIndex, opts.queriesPerRun)) {
      if (!budget.canSpend(opts.search.costPerQueryUsd + est.detectionUsd)) {
        exhausted = true;
        break;
      }
      let results: WebSearchResult[];
      try {
        results = await opts.search.search({ query: q.query, count: 10, freshness: q.freshness });
      } catch (err) {
        errors.push(`search "${q.query}": ${String(err)}`);
        budget.recordSearch(opts.search.costPerQueryUsd);
        continue;
      }
      budget.recordSearch(opts.search.costPerQueryUsd);
      const known = await knownIntelLeadHashes(results.map((r) => urlHash(r.url)));
      const fresh = results.filter((r) => !known.has(urlHash(r.url)) && detectInjection(`${r.title} ${r.snippet}`).length === 0);
      (notes.queries as unknown[]).push({ q: q.query, results: results.length, new: fresh.length });
      if (fresh.length === 0) continue;

      let detection: Detection;
      try {
        const { prompt, untrusted } = detectionPrompt(q.query, fresh);
        const res = await opts.llm.runStructured({ taskClass: "extraction", system: DETECTION_SYSTEM, prompt, untrustedContext: untrusted }, DetectionSchema);
        budget.recordLlm(res.telemetry.usd);
        detection = res.value;
      } catch (err) {
        errors.push(`detect "${q.query}": ${String(err).slice(0, 200)}`);
        continue;
      }

      for (const lead of detection.leads) {
        const result = fresh[lead.index];
        if (!result || lead.credibility < MIN_CREDIBILITY) continue;
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
        });
        if (!leadId) continue;
        await touchIntelSource(result.hostname, lead.kind, { leads: 1 });
        detected.push({ ...lead, result, query: q.query, leadId });
      }
    }

    // ---- Stage 3-6: opposite side, verification, economics, why-paid, contact → candidate
    const urgencyWeight = { high: 1, medium: 0.8, low: 0.6 } as const;
    const ranked = [...detected].sort((a, b) => b.credibility * urgencyWeight[b.urgency] - a.credibility * urgencyWeight[a.urgency]);
    let candidates = 0;
    for (const lead of ranked.slice(0, opts.maxAssessments)) {
      const counter: WebSearchResult[] = [];
      if (lead.kind !== "problem") {
        for (const oq of lead.opposite_queries.slice(0, 2)) {
          if (!budget.canSpend(opts.search.costPerQueryUsd + est.assessmentUsd)) break;
          try {
            const found = await opts.search.search({ query: oq, count: 5, freshness: "month" });
            counter.push(...found.filter((r) => detectInjection(`${r.title} ${r.snippet}`).length === 0));
          } catch (err) {
            errors.push(`opposite "${oq}": ${String(err)}`);
          }
          budget.recordSearch(opts.search.costPerQueryUsd);
        }
      }
      if (!budget.canSpend(est.assessmentUsd)) {
        exhausted = true;
        break;
      }
      let a: Assessment;
      try {
        const { prompt, untrusted } = assessmentPrompt(
          { kind: lead.kind, title: lead.title, summary: lead.summary, url: lead.result.url, publishedAt: lead.result.publishedAt, facts: lead.facts, contact: lead.contact },
          counter,
        );
        const res = await opts.llm.runStructured({ taskClass: "research_synthesis", system: ASSESSMENT_SYSTEM, prompt, untrustedContext: untrusted }, AssessmentSchema);
        budget.recordLlm(res.telemetry.usd);
        a = res.value;
      } catch (err) {
        errors.push(`assess ${lead.result.url}: ${String(err).slice(0, 200)}`);
        continue;
      }

      const bucket = await persistCandidate(runId, lead, counter, a);
      await setIntelLeadStatus(lead.leadId, "assessed");
      if (bucket === "act_now" || bucket === "verify_next") await touchIntelSource(lead.result.hostname, lead.kind, { actionable: 1 });
      candidates++;
    }

    const totals: IntelRunTotals = {
      status: exhausted ? "budget_exhausted" : "completed",
      searchCalls: budget.searchCalls,
      llmCalls: budget.llmCalls,
      searchUsd: budget.searchUsd,
      llmUsd: budget.llmUsd,
      leadsFound: detected.length,
      candidates,
      notes,
    };
    await finishIntelRun(runId, totals);
    log.info({ runId, ...totals, notes: undefined, errors: errors.length }, "intel.run.complete");
    return { runId, ...totals };
  } catch (err) {
    const totals: IntelRunTotals = {
      status: "failed",
      searchCalls: budget.searchCalls,
      llmCalls: budget.llmCalls,
      searchUsd: budget.searchUsd,
      llmUsd: budget.llmUsd,
      leadsFound: detected.length,
      candidates: 0,
      notes: { ...notes, fatal: String(err) },
    };
    await finishIntelRun(runId, totals);
    throw err;
  }
}

/** Applies the deterministic decision layer to one assessment and stores the candidate. */
async function persistCandidate(runId: string, lead: DetectedLead, counter: WebSearchResult[], a: Assessment) {
  const service = lead.kind === "problem" ? serviceByKey(a.service_key) : undefined;
  const counterResult = a.counter_index !== null ? counter[a.counter_index] : undefined;
  const counterpartyFound = a.counterparty_found && (lead.kind === "problem" ? service !== undefined : counterResult !== undefined);

  const freshness = freshnessScore(lead.result.publishedAt, lead.urgency);
  const contact = (a.contact ?? lead.contact ?? null) as ContactPath | null;
  const screenText = [lead.title, lead.summary, lead.result.snippet, counterResult?.snippet ?? ""].join(" ");
  const regulatory = mergeFlags(a.regulatory, regulatoryFlags(screenText));
  const fraud = mergeFlags(a.fraud, fraudFlags(screenText));
  const monetization = { payer: a.monetization.payer, mechanism: a.monetization.mechanism, timing: a.monetization.timing, valueAdded: a.monetization.value_added };
  const resolved = monetizationResolved(monetization);
  const verification = verificationStatus({ evidence: a.evidence, publishedAt: lead.result.publishedAt, freshness, contact, counterpartyFound });
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
  const { bucket, rejectReason } = bucketFor({
    ...scoreInput,
    compensationHighUsd: Math.max(...a.economics.user_compensation_usd),
  });
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
    outreach: { primary: a.outreach.primary, secondary: a.outreach.secondary, requiresApproval: true },
    bucket,
    rejectReason: rejectReason ?? (counterpartyFound ? null : "no_counterparty_found"),
  });
  return bucket;
}
