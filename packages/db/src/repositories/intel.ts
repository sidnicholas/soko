import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { factEvidence, insertEvidence } from "./economics";

/** AIOOS opportunity intelligence persistence (migration 0019). jsonb writes are JSON.stringify'd (repo convention). */

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Search + LLM spend since 00:00 UTC — the daily cap is enforced against this. */
export async function intelSpentTodayUsd(): Promise<number> {
  const row = await getDb()
    .selectFrom("intel_runs")
    .select(sql<string>`coalesce(sum(search_usd + llm_usd), 0)`.as("usd"))
    .where("started_at", ">=", sql<string>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
    .executeTakeFirst();
  return Number(row?.usd ?? 0);
}

export async function countIntelRuns(): Promise<number> {
  const row = await getDb().selectFrom("intel_runs").select(sql<number>`count(*)::int`.as("n")).executeTakeFirst();
  return row?.n ?? 0;
}

export async function createIntelRun(lane: "all" | "demand" | "supply" = "all"): Promise<string> {
  const row = await getDb().insertInto("intel_runs").values({ notes: json({}), lane }).returning("id").executeTakeFirstOrThrow();
  return row.id;
}

export interface IntelRunTotals {
  status: "completed" | "budget_exhausted" | "failed";
  searchCalls: number;
  llmCalls: number;
  searchUsd: number;
  llmUsd: number;
  leadsFound: number;
  candidates: number;
  notes: Record<string, unknown>;
}

export async function finishIntelRun(id: string, t: IntelRunTotals): Promise<void> {
  await getDb()
    .updateTable("intel_runs")
    .set({
      finished_at: new Date().toISOString(),
      status: t.status,
      search_calls: t.searchCalls,
      llm_calls: t.llmCalls,
      search_usd: t.searchUsd.toFixed(6),
      llm_usd: t.llmUsd.toFixed(6),
      leads_found: t.leadsFound,
      candidates: t.candidates,
      notes: json(t.notes),
    })
    .where("id", "=", id)
    .execute();
}

/** Which of these url hashes are already leads — so a re-surfaced page costs no LLM call. */
export async function knownIntelLeadHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await getDb().selectFrom("intel_leads").select("url_hash").where("url_hash", "in", hashes).execute();
  return new Set(rows.map((r) => r.url_hash));
}

export interface NewIntelLead {
  /** Null for a lead raised outside a search run (a deal check, ADR-044). */
  runId: string | null;
  kind: "demand" | "supply" | "problem";
  title: string;
  summary: string;
  url: string;
  urlHash: string;
  hostname: string;
  query: string;
  searchProvider: string;
  publishedAt: string | null;
  ageText: string | null;
  item: string | null;
  category: string | null;
  quantity: string | null;
  location: string | null;
  deadline: string | null;
  priceMinor: number | null;
  currency: string | null;
  urgency: "low" | "medium" | "high";
  credibility: number;
  contact: unknown;
  facts: unknown;
  oppositeQueries: string[];
  signalType?: string | null;
  evidenceLevel?: "observed" | "inferred";
  supplyTerms?: Record<string, unknown>;
  titleUnverified?: boolean;
  /** The search result's own title and snippet, kept as evidence. */
  evidenceTitle?: string | null;
  evidenceExcerpt?: string | null;
}

/** Inserts a lead; returns its id, or null when the page is already a lead. */
/**
 * Stores a detected lead (deduped by URL). A new supply lead emits
 * surplus.detected.v1 in the same transaction (PRD v2 §8).
 */
export async function insertIntelLead(l: NewIntelLead): Promise<string | null> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
  const row = await tx
    .insertInto("intel_leads")
    .values({
      run_id: l.runId,
      kind: l.kind,
      title: l.title,
      summary: l.summary,
      url: l.url,
      url_hash: l.urlHash,
      hostname: l.hostname,
      query: l.query,
      search_provider: l.searchProvider,
      published_at: l.publishedAt,
      age_text: l.ageText,
      item: l.item,
      category: l.category,
      quantity: l.quantity,
      location: l.location,
      deadline: l.deadline,
      price_minor: l.priceMinor,
      currency: l.currency,
      urgency: l.urgency,
      credibility: l.credibility.toFixed(3),
      contact: json(l.contact),
      facts: json(l.facts),
      opposite_queries: json(l.oppositeQueries),
      signal_type: l.signalType ?? null,
      evidence_level: l.evidenceLevel ?? "observed",
      supply_terms: json(l.supplyTerms ?? {}),
      title_unverified: l.titleUnverified ?? false,
      // A problem matched to the user's own services needs no search for the other side.
      counterpart_status: l.oppositeQueries.length === 0 ? "not_needed" : "pending",
    })
    .onConflict((oc) => oc.column("url_hash").doNothing())
    .returning("id")
    .executeTakeFirst();
  // What the lead rests on, as captured (PRD v2 FR-04): the page and its stated facts.
  if (row) {
    await insertEvidence(tx, "intel_lead", row.id, [
      { kind: "source_page", url: l.url, title: l.evidenceTitle ?? l.title, excerpt: l.evidenceExcerpt ?? l.summary, label: "source_fact", observedAt: l.publishedAt },
      ...factEvidence(l.facts),
    ]);
  }
  if (row && l.kind === "supply") {
    await enqueueEvent(tx, {
      eventName: "surplus.detected.v1",
      aggregateType: "intel_lead",
      aggregateId: row.id,
      idempotencyKey: `surplus.detected:${row.id}:${randomUUID()}`,
      payload: { leadId: row.id, signalType: l.signalType ?? null, evidenceLevel: l.evidenceLevel ?? "observed", titleUnverified: l.titleUnverified ?? false, hostname: l.hostname },
    });
  }
  return row?.id ?? null;
    });
}

/** A known page seen again: last_seen_at and seen_count capture that it is still up (FR-02). */
export async function touchIntelLeadsSeen(urlHashes: string[]): Promise<void> {
  if (urlHashes.length === 0) return;
  await getDb()
    .updateTable("intel_leads")
    .set({ last_seen_at: sql`now()`, seen_count: sql`seen_count + 1` })
    .where("url_hash", "in", urlHashes)
    .execute();
}

export async function setIntelLeadStatus(id: string, status: "assessed" | "skipped"): Promise<void> {
  await getDb().updateTable("intel_leads").set({ status }).where("id", "=", id).execute();
}

/** Source registry upsert (AIOOS §3): counts leads and actionable candidates per host. */
export async function touchIntelSource(hostname: string, orientation: string, delta: { leads?: number; actionable?: number }): Promise<void> {
  await getDb()
    .insertInto("intel_sources")
    .values({ hostname, orientation, leads: delta.leads ?? 0, actionable: delta.actionable ?? 0 })
    .onConflict((oc) =>
      oc.column("hostname").doUpdateSet({
        leads: sql`intel_sources.leads + ${delta.leads ?? 0}`,
        actionable: sql`intel_sources.actionable + ${delta.actionable ?? 0}`,
        last_seen_at: sql`now()`,
        orientation: sql`case when intel_sources.orientation = ${orientation} then intel_sources.orientation else 'mixed' end`,
      }),
    )
    .execute();
}

export interface NewIntelCandidate {
  runId: string;
  leadId: string;
  counterUrl: string | null;
  counterSummary: string | null;
  serviceKey: string | null;
  matchKind: "demand_to_supply" | "supply_to_demand" | "problem_to_service";
  title: string;
  matchRationale: string;
  verificationStatus: string;
  freshness: number;
  economics: unknown;
  monetization: unknown;
  regulatoryFlags: unknown;
  fraudFlags: unknown;
  contact: unknown;
  evLowUsd: number;
  evHighUsd: number;
  confidence: string;
  score: number;
  explanation: unknown;
  outreach: unknown;
  bucket: string;
  rejectReason: string | null;
}

/** Column values for a candidate row (shared by the plain upsert and the assessed one). */
export function candidateValues(c: NewIntelCandidate) {
  return {
    run_id: c.runId,
    lead_id: c.leadId,
    counter_url: c.counterUrl,
    counter_summary: c.counterSummary,
    service_key: c.serviceKey,
    match_kind: c.matchKind,
    title: c.title,
    match_rationale: c.matchRationale,
    verification_status: c.verificationStatus,
    freshness: c.freshness.toFixed(3),
    economics: json(c.economics),
    monetization: json(c.monetization),
    regulatory_flags: json(c.regulatoryFlags),
    fraud_flags: json(c.fraudFlags),
    contact: json(c.contact),
    ev_low_usd: c.evLowUsd.toFixed(2),
    ev_high_usd: c.evHighUsd.toFixed(2),
    confidence: c.confidence,
    score: c.score.toFixed(2),
    explanation: json(c.explanation),
    outreach: json(c.outreach),
    bucket: c.bucket,
    reject_reason: c.rejectReason,
  };
}

export async function upsertIntelCandidate(c: NewIntelCandidate): Promise<string> {
  const values = candidateValues(c);
  const row = await getDb()
    .insertInto("intel_candidates")
    .values(values)
    .onConflict((oc) => oc.columns(["lead_id", "match_kind"]).doUpdateSet({ ...values, updated_at: sql`now()` }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

const CANDIDATE_COLUMNS = [
  "c.id",
  "c.lead_id",
  "c.counter_url",
  "c.counter_summary",
  "c.service_key",
  "c.match_kind",
  "c.title",
  "c.match_rationale",
  "c.verification_status",
  "c.freshness",
  "c.economics",
  "c.monetization",
  "c.regulatory_flags",
  "c.fraud_flags",
  "c.contact",
  "c.ev_low_usd",
  "c.ev_high_usd",
  "c.confidence",
  "c.score",
  "c.explanation",
  "c.outreach",
  "c.bucket",
  "c.reject_reason",
  "c.user_status",
  "c.outcome_reason",
  "c.outcome_note",
  "c.realized_usd",
  "c.created_at",
  "c.updated_at",
  "l.kind as lead_kind",
  "l.title as lead_title",
  "l.summary as lead_summary",
  "l.url as lead_url",
  "l.hostname as lead_hostname",
  "l.query as lead_query",
  "l.published_at as lead_published_at",
  "l.age_text as lead_age_text",
  "l.discovered_at as lead_discovered_at",
  "l.facts as lead_facts",
] as const;

/** Open candidates by bucket, best first; rejected limited to the most recent. */
export async function listIntelQueue(rejectedLimit = 50) {
  const db = getDb();
  const open = await db
    .selectFrom("intel_candidates as c")
    .innerJoin("intel_leads as l", "l.id", "c.lead_id")
    .leftJoin("crm_links as k", (j) => j.onRef("k.subject_id", "=", "c.id").on("k.subject_type", "=", "intel_candidate").on("k.provider", "=", "pipedrive"))
    .select(CANDIDATE_COLUMNS)
    .select(["k.external_url as crm_url", "k.external_status as crm_status", "k.external_stage_id as crm_stage_id"])
    .where("c.bucket", "!=", "rejected")
    .where("c.user_status", "not in", ["dismissed", "won", "lost"])
    .orderBy("c.score", "desc")
    .limit(200)
    .execute();
  const rejected = await db
    .selectFrom("intel_candidates as c")
    .innerJoin("intel_leads as l", "l.id", "c.lead_id")
    .leftJoin("crm_links as k", (j) => j.onRef("k.subject_id", "=", "c.id").on("k.subject_type", "=", "intel_candidate").on("k.provider", "=", "pipedrive"))
    .select(CANDIDATE_COLUMNS)
    .select(["k.external_url as crm_url", "k.external_status as crm_status", "k.external_stage_id as crm_stage_id"])
    .where("c.bucket", "=", "rejected")
    .orderBy("c.created_at", "desc")
    .limit(rejectedLimit)
    .execute();
  return { open, rejected };
}

export async function getIntelCandidate(id: string) {
  return getDb()
    .selectFrom("intel_candidates as c")
    .innerJoin("intel_leads as l", "l.id", "c.lead_id")
    .leftJoin("crm_links as k", (j) => j.onRef("k.subject_id", "=", "c.id").on("k.subject_type", "=", "intel_candidate").on("k.provider", "=", "pipedrive"))
    .select(CANDIDATE_COLUMNS)
    .select(["k.external_url as crm_url", "k.external_status as crm_status", "k.external_stage_id as crm_stage_id"])
    .where("c.id", "=", id)
    .executeTakeFirst();
}

/** Human outcome feedback (AIOOS §24-§25): status plus a reason code and realized revenue. */
export async function updateIntelCandidateStatus(id: string, input: { status: string; reason: string | null; realizedUsd: number | null; note?: string | null }) {
  return getDb()
    .updateTable("intel_candidates")
    .set({
      user_status: input.status,
      outcome_reason: input.reason,
      // A status change without a note keeps the one already written.
      ...(input.note !== undefined ? { outcome_note: input.note } : {}),
      realized_usd: input.realizedUsd === null ? null : input.realizedUsd.toFixed(2),
      updated_at: sql`now()`,
    })
    .where("id", "=", id)
    .returning("id")
    .executeTakeFirst();
}

/** Success metrics (AIOOS §22, §30): spend, actionable count, cost per actionable, outcomes. */
export async function intelStats() {
  const db = getDb();
  const spend = await db
    .selectFrom("intel_runs")
    .select([
      sql<string>`coalesce(sum(search_usd + llm_usd) filter (where started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'), 0)`.as("today"),
      sql<string>`coalesce(sum(search_usd + llm_usd), 0)`.as("total"),
      sql<number>`count(*)::int`.as("runs"),
      sql<string | null>`max(started_at)::text`.as("last_run_at"),
    ])
    .executeTakeFirstOrThrow();
  const counts = await db
    .selectFrom("intel_candidates")
    .select([
      sql<number>`count(*) filter (where bucket in ('act_now', 'verify_next'))::int`.as("actionable"),
      sql<number>`count(*) filter (where user_status in ('contacted', 'responded', 'won', 'lost'))::int`.as("contacted"),
      sql<number>`count(*) filter (where user_status in ('responded', 'won'))::int`.as("responded"),
      sql<number>`count(*) filter (where user_status = 'won')::int`.as("won"),
      sql<string>`coalesce(sum(realized_usd), 0)`.as("realized_usd"),
    ])
    .executeTakeFirstOrThrow();
  const leads = await db.selectFrom("intel_leads").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
  const total = Number(spend.total);
  return {
    spentTodayUsd: Number(spend.today),
    spentTotalUsd: total,
    runs: spend.runs,
    lastRunAt: spend.last_run_at,
    leads: leads.n,
    actionable: counts.actionable,
    contacted: counts.contacted,
    responded: counts.responded,
    won: counts.won,
    realizedUsd: Number(counts.realized_usd),
    costPerActionableUsd: counts.actionable > 0 ? total / counts.actionable : null,
    costPerRealizedDollar: Number(counts.realized_usd) > 0 ? total / Number(counts.realized_usd) : null,
  };
}

/** Source registry with yield, best first. */
export async function listIntelSources() {
  return getDb()
    .selectFrom("intel_sources")
    .selectAll()
    .orderBy(sql`actionable::float / greatest(leads, 1)`, "desc")
    .orderBy("leads", "desc")
    .limit(100)
    .execute();
}

/** Runs already started this UTC day — the pacing input for the per-run budget share. */
export async function intelRunsStartedToday(): Promise<number> {
  const row = await getDb()
    .selectFrom("intel_runs")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("started_at", ">=", sql<string>`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
    .executeTakeFirst();
  return row?.n ?? 0;
}

/**
 * Leads detected in earlier runs but never assessed (status 'new'), most
 * credible first, so a better lead found yesterday isn't lost behind today's.
 */
/**
 * Unassessed leads ready for assessment: recent, of the lane's kinds, and
 * past the counterpart search (found, none found, or not needed).
 */
export async function listUnassessedIntelLeads(opts: { sinceDays: number; limit: number; excludeIds: string[]; kinds?: string[] }) {
  let q = getDb()
    .selectFrom("intel_leads")
    .select([
      "id",
      "run_id",
      "kind",
      "title",
      "summary",
      "url",
      "hostname",
      "published_at",
      "urgency",
      "credibility",
      "contact",
      "facts",
      "opposite_queries",
      "discovered_at",
      "signal_type",
      "evidence_level",
      "title_unverified",
      "counterpart_status",
      "counterparts",
    ])
    .where("status", "=", "new")
    .where("counterpart_status", "<>", "pending")
    .where("discovered_at", ">=", sql<string>`now() - make_interval(days => ${opts.sinceDays})`)
    .orderBy("credibility", "desc")
    .orderBy("discovered_at", "desc")
    .limit(opts.limit);
  if (opts.excludeIds.length > 0) q = q.where("id", "not in", opts.excludeIds);
  if (opts.kinds && opts.kinds.length > 0) q = q.where("kind", "in", opts.kinds);
  return q.execute();
}

/** Leads whose search for the other side is due: never searched, or a retry whose time has come. */
export async function listCounterpartDue(opts: { kinds: string[]; sinceDays: number; limit: number }) {
  if (opts.kinds.length === 0 || opts.limit <= 0) return [];
  return getDb()
    .selectFrom("intel_leads")
    .select(["id", "kind", "title", "hostname", "opposite_queries", "counterpart_attempts"])
    .where("status", "=", "new")
    .where("kind", "in", opts.kinds)
    .where("discovered_at", ">=", sql<string>`now() - make_interval(days => ${opts.sinceDays})`)
    .where((eb) => eb.or([eb("counterpart_status", "=", "pending"), eb.and([eb("counterpart_status", "=", "none_found"), eb("counterpart_next_at", "<=", sql<string>`now()`)])]))
    .orderBy("credibility", "desc")
    .orderBy("discovered_at", "desc")
    .limit(opts.limit)
    .execute();
}

export interface StoredCounterpart {
  url: string;
  title: string;
  snippet: string;
  hostname: string;
  publishedAt: string | null;
  query: string;
}

export async function setLeadCounterparts(id: string, r: { status: "found" | "none_found" | "not_needed"; attempts: number; nextAt: string | null; counterparts: StoredCounterpart[] }): Promise<void> {
  await getDb()
    .updateTable("intel_leads")
    .set({ counterpart_status: r.status, counterpart_attempts: r.attempts, counterpart_next_at: r.nextAt, counterparts: json(r.counterparts) })
    .where("id", "=", id)
    .execute();
}

/**
 * Yield per stage-1 query (AIOOS §3, §22, §32): how often it ran, what it
 * returned, how many results were new, and how many leads / actionable
 * candidates it produced — the evidence for pruning or expanding the pool.
 */
export async function listIntelQueryYield(limit = 100) {
  const result = await sql<{
    query: string;
    searches: number;
    results: number;
    new_results: number;
    leads: number;
    assessed: number;
    actionable: number;
    last_run_at: string | null;
    /** Why results from this query weren't leads: reason → count, summed over runs. */
    reasons: Record<string, number>;
  }>`
    with runs as (
      select q->>'q' as query, count(*)::int as searches,
             coalesce(sum((q->>'results')::int), 0)::int as results,
             coalesce(sum((q->>'new')::int), 0)::int as new_results,
             max(r.started_at)::text as last_run_at
      from intel_runs r, jsonb_array_elements(coalesce(r.notes->'queries', '[]'::jsonb)) as q
      group by 1
    ),
    leads as (
      select l.query, count(distinct l.id)::int as leads,
             count(distinct l.id) filter (where l.status = 'assessed')::int as assessed,
             count(distinct c.id) filter (where c.bucket in ('act_now', 'verify_next'))::int as actionable
      from intel_leads l left join intel_candidates c on c.lead_id = l.id
      group by 1
    )
    , reasons as (
      select query, jsonb_object_agg(reason, n) as reasons
      from (
        select q->>'q' as query, r.key as reason, sum(r.value::int)::int as n
        from intel_runs ir, jsonb_array_elements(coalesce(ir.notes->'queries', '[]'::jsonb)) as q,
             jsonb_each_text(coalesce(q->'reasons', '{}'::jsonb)) as r
        group by 1, 2
      ) summed
      group by 1
    )
    select runs.query, runs.searches, runs.results, runs.new_results,
           coalesce(leads.leads, 0)::int as leads, coalesce(leads.assessed, 0)::int as assessed,
           coalesce(leads.actionable, 0)::int as actionable, runs.last_run_at,
           coalesce(reasons.reasons, '{}'::jsonb) as reasons
    from runs left join leads on leads.query = runs.query
              left join reasons on reasons.query = runs.query
    order by actionable desc, leads desc, searches desc
    limit ${limit}
  `.execute(getDb());
  return result.rows;
}

