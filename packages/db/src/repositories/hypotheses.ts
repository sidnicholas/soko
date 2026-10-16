import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/**
 * Demand hypotheses (migration 0026, PRD v2 FR-03): inferred demand on a
 * watchlist. Revisited on schedule, confirmed only by an observed lead,
 * expired by rule. Never part of the action queue or the opportunity feed.
 */

const json = (v: unknown) => JSON.stringify(v ?? null);

export interface NewDemandHypothesis {
  runId: string;
  signalType: string;
  hypothesis: string;
  basis: string;
  evidence: unknown[];
  sourceUrl: string;
  sourceUrlHash: string;
  hostname: string;
  query: string;
  item: string | null;
  location: string | null;
  confidence: number;
  checkQuery: string | null;
  revisitDays: number;
  revisitAt: string;
  expiresAt: string;
}

/** Stores a hypothesis (deduped by source page) and emits signal.hypothesis_created.v1 in the same transaction. */
export async function insertDemandHypothesis(h: NewDemandHypothesis): Promise<string | null> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("demand_hypotheses")
        .values({
          run_id: h.runId,
          signal_type: h.signalType,
          hypothesis: h.hypothesis,
          basis: h.basis,
          evidence: json(h.evidence),
          source_url: h.sourceUrl,
          source_url_hash: h.sourceUrlHash,
          hostname: h.hostname,
          query: h.query,
          item: h.item,
          location: h.location,
          confidence: h.confidence.toFixed(3),
          check_query: h.checkQuery,
          revisit_days: h.revisitDays,
          revisit_at: h.revisitAt,
          expires_at: h.expiresAt,
        })
        .onConflict((oc) => oc.column("source_url_hash").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) {
        await enqueueEvent(tx, {
          eventName: "signal.hypothesis_created.v1",
          aggregateType: "demand_hypothesis",
          aggregateId: row.id,
          idempotencyKey: `signal.hypothesis_created:${row.id}:${randomUUID()}`,
          payload: { hypothesisId: row.id, signalType: h.signalType, hostname: h.hostname, expiresAt: h.expiresAt },
        });
      }
      return row?.id ?? null;
    });
}

/** Hypotheses whose lifetime has ended stop being watched. Returns how many. */
export async function expireDemandHypotheses(): Promise<number> {
  const r = await getDb()
    .updateTable("demand_hypotheses")
    .set({ status: "expired", status_reason: "lifetime_ended", updated_at: sql`now()` })
    .where("status", "=", "watching")
    .where("expires_at", "<=", sql<string>`now()`)
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0n);
}

/** Watched hypotheses due for a revisit, most confident first. */
export async function listDueHypotheses(limit: number) {
  if (limit <= 0) return [];
  return getDb()
    .selectFrom("demand_hypotheses")
    .select(["id", "hypothesis", "check_query", "revisit_days", "revisit_count", "checks"])
    .where("status", "=", "watching")
    .where("revisit_at", "<=", sql<string>`now()`)
    .where("check_query", "is not", null)
    .orderBy("confidence", "desc")
    .orderBy("revisit_at")
    .limit(limit)
    .execute();
}

export interface HypothesisCheck {
  at: string;
  query: string;
  results: number;
  outcome: "confirmed" | "not_yet" | "error";
  leadId?: string | null;
  note?: string;
}

/**
 * Records one revisit. Confirmed (an observed lead now states the need): the
 * hypothesis links to it and stops being watched. Otherwise the next revisit
 * is scheduled.
 */
export async function recordHypothesisCheck(id: string, check: HypothesisCheck, nextRevisitAt: string | null): Promise<void> {
  const confirmed = check.outcome === "confirmed";
  await getDb()
    .updateTable("demand_hypotheses")
    .set({
      checks: sql`checks || ${json([check])}::jsonb`,
      revisit_count: sql`revisit_count + 1`,
      ...(confirmed ? { status: "confirmed", status_reason: "observed_lead_found", confirmed_lead_id: check.leadId ?? null } : {}),
      ...(nextRevisitAt && !confirmed ? { revisit_at: nextRevisitAt } : {}),
      updated_at: sql`now()`,
    })
    .where("id", "=", id)
    .execute();
}

export async function setHypothesisStatus(id: string, status: "watching" | "dismissed", reason: string | null) {
  return getDb()
    .updateTable("demand_hypotheses")
    .set({ status, status_reason: reason, updated_at: sql`now()` })
    .where("id", "=", id)
    .where("status", "in", ["watching", "dismissed"])
    .returning(["id", "status", "status_reason"])
    .executeTakeFirst();
}

export async function listDemandHypotheses(opts: { status?: string; limit?: number } = {}) {
  let q = getDb()
    .selectFrom("demand_hypotheses")
    .select([
      "id",
      "signal_type",
      "hypothesis",
      "basis",
      "evidence",
      "source_url",
      "hostname",
      "item",
      "location",
      sql<number>`confidence::float`.as("confidence"),
      "check_query",
      "status",
      "status_reason",
      sql<string>`revisit_at::text`.as("revisit_at"),
      sql<string>`expires_at::text`.as("expires_at"),
      "revisit_count",
      "checks",
      "confirmed_lead_id",
      sql<string>`created_at::text`.as("created_at"),
    ])
    .orderBy(sql`case status when 'watching' then 0 when 'confirmed' then 1 else 2 end`)
    .orderBy("created_at", "desc")
    .limit(opts.limit ?? 300);
  if (opts.status) q = q.where("status", "=", opts.status);
  return q.execute();
}

/**
 * Leads of the given kinds from the last `days` days, newest first, with
 * their supply/demand fields, counterpart search and any candidate's bucket.
 */
export async function listIntelligenceLeads(kinds: string[], days: number, limit = 300) {
  return getDb()
    .selectFrom("intel_leads as l")
    .leftJoin("intel_candidates as c", "c.lead_id", "l.id")
    .select([
      "l.id",
      "l.kind",
      "l.title",
      "l.summary",
      "l.url",
      "l.hostname",
      "l.item",
      "l.category",
      "l.quantity",
      "l.location",
      "l.deadline",
      "l.price_minor",
      "l.currency",
      "l.urgency",
      sql<number>`l.credibility::float`.as("credibility"),
      "l.contact",
      "l.facts",
      "l.signal_type",
      "l.evidence_level",
      "l.supply_terms",
      "l.title_unverified",
      sql<string>`l.discovered_at::text`.as("discovered_at"),
      sql<string | null>`l.published_at::text`.as("published_at"),
      sql<string>`l.last_seen_at::text`.as("last_seen_at"),
      "l.seen_count",
      "l.status",
      "l.counterpart_status",
      "l.counterparts",
      "c.bucket",
      "c.reject_reason",
    ])
    .where("l.kind", "in", kinds)
    .where("l.discovered_at", ">=", sql<string>`now() - make_interval(days => ${days})`)
    .orderBy("l.discovered_at", "desc")
    .limit(limit)
    .execute();
}
