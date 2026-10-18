import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { followUpCounts, listFollowUps } from "./followups";

/**
 * Daily brief (migration 0037, ADR-046): the raw facts for one period, read
 * in one place, and the stored briefs. Building the text is
 * `@opportunity-os/briefing`; this file only reads and stores.
 */

export interface BriefData {
  periodStart: string;
  periodEnd: string;
  candidates: { id: string; title: string; bucket: string; score: number; ev_low_usd: number; ev_high_usd: number; confidence: string; lead_kind: string; lead_url: string; counter_url: string | null }[];
  actionableCount: number;
  outreach: {
    needsReview: { conversation_id: string; party_name: string; subject: string; classification: string }[];
    drafts: number;
    queued: number;
    exceptions: number;
    sent: number;
    replies: number;
    optOuts: number;
    bounces: number;
  };
  deals: {
    checked: number;
    goodDeals: number;
    leadsRaised: number;
    top: { lead_id: string; title: string; url: string; discount: number; price_minor: number | null; comp_median_minor: number | null; currency: string | null; demand_term: string | null }[];
  };
  sources: {
    active: number;
    pausedInPeriod: { id: string; name: string; reason: string | null }[];
    failing: { id: string; name: string; consecutive_failures: number }[];
    apifyRuns: number;
    apifyFailed: number;
    apifyItemsNew: number;
    quarantinePending: number;
  };
  spend: { intelUsd: number; apifyUsd: number };
  /** As of the end of the period (ADR-047). */
  followUps: {
    due: number;
    cold: number;
    stalled: number;
    upcoming: number;
    top: { id: string; title: string; stage: string; action: string; next_at: string | null; last_touch_at: string; lead_url: string }[];
  };
}

const n = (v: unknown) => Number(v ?? 0);

export async function gatherBriefData(periodStart: Date, periodEnd: Date): Promise<BriefData> {
  const db = getDb();
  const from = periodStart.toISOString();
  const to = periodEnd.toISOString();
  const inPeriod = (col: string) => sql<boolean>`${sql.ref(col)} >= ${from}::timestamptz and ${sql.ref(col)} < ${to}::timestamptz`;
  const count = (rows: { n: unknown } | undefined) => n(rows?.n);

  const [candidates, actionable, needsReview, outCounts, inCounts, dealCounts, topDeals, active, paused, failing, apify, quarantine, intelSpend] = await Promise.all([
    db
      .selectFrom("intel_candidates as c")
      .innerJoin("intel_leads as l", "l.id", "c.lead_id")
      .select(["c.id", "c.title", "c.bucket", sql<number>`c.score::float`.as("score"), sql<number>`c.ev_low_usd::float`.as("ev_low_usd"), sql<number>`c.ev_high_usd::float`.as("ev_high_usd"), "c.confidence", "l.kind as lead_kind", "l.url as lead_url", "c.counter_url"])
      .where("c.bucket", "in", ["act_now", "verify_next"])
      .where(inPeriod("c.created_at"))
      .orderBy(sql`c.bucket = 'act_now'`, "desc")
      .orderBy("c.score", "desc")
      .limit(8)
      .execute(),
    db.selectFrom("intel_candidates").select(sql<number>`count(*)::int`.as("n")).where("bucket", "in", ["act_now", "verify_next"]).where(inPeriod("created_at")).executeTakeFirst(),
    db
      .selectFrom("conversation_messages as m")
      .innerJoin("conversations as c", "c.id", "m.conversation_id")
      .innerJoin("counterparties as p", "p.id", "c.counterparty_id")
      .select(["c.id as conversation_id", sql<string>`coalesce(p.display_name, p.normalized_name)`.as("party_name"), "m.subject", sql<string>`m.classification`.as("classification")])
      .where("m.direction", "=", "inbound")
      .where("m.reviewed_at", "is", null)
      .where("m.classification", "in", ["reply", "opt_out"])
      .orderBy("m.received_at", "desc")
      .limit(10)
      .execute(),
    db
      .selectFrom("conversation_messages")
      .select([
        sql<number>`count(*) filter (where status = 'draft')::int`.as("drafts"),
        sql<number>`count(*) filter (where status in ('queued', 'sending'))::int`.as("queued"),
        sql<number>`count(*) filter (where status = 'failed' and created_at > now() - interval '30 days')::int`.as("failed"),
        sql<number>`count(*) filter (where status = 'sent' and sent_at >= ${from}::timestamptz and sent_at < ${to}::timestamptz)::int`.as("sent"),
      ])
      .where("direction", "=", "outbound")
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("conversation_messages")
      .select([
        sql<number>`count(*) filter (where classification = 'reply')::int`.as("replies"),
        sql<number>`count(*) filter (where classification = 'opt_out')::int`.as("opt_outs"),
        sql<number>`count(*) filter (where classification = 'bounce')::int`.as("bounces"),
      ])
      .where("direction", "=", "inbound")
      .where(inPeriod("created_at"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("deal_checks")
      .select([sql<number>`count(*)::int`.as("checked"), sql<number>`count(*) filter (where verdict = 'good_deal')::int`.as("good"), sql<number>`count(lead_id)::int`.as("leads")])
      .where(inPeriod("checked_at"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("deal_checks as d")
      .innerJoin("intel_leads as l", "l.id", "d.lead_id")
      .select(["d.lead_id", "l.title", "l.url", sql<number>`d.discount::float`.as("discount"), sql<number | null>`d.price_minor::bigint`.as("price_minor"), sql<number | null>`d.comp_median_minor::bigint`.as("comp_median_minor"), "d.currency", "d.demand_term"])
      .where("d.verdict", "=", "good_deal")
      .where(inPeriod("d.checked_at"))
      .orderBy("d.discount", "desc")
      .limit(5)
      .execute(),
    db.selectFrom("source_registry").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "active").executeTakeFirst(),
    db
      .selectFrom("outbox as o")
      .innerJoin("source_registry as s", (j) => j.on(sql`s.id::text`, "=", sql.ref("o.aggregate_id")))
      .select(["s.id", "s.name", "s.status_reason as reason"])
      .where("o.event_name", "=", "source.paused.v1")
      .where(inPeriod("o.created_at"))
      .where("s.status", "=", "paused")
      .distinct()
      .limit(10)
      .execute(),
    db.selectFrom("source_registry").select(["id", "name", "consecutive_failures"]).where("status", "=", "active").where("consecutive_failures", ">", 0).orderBy("consecutive_failures", "desc").limit(10).execute(),
    db
      .selectFrom("apify_runs")
      .select([
        sql<number>`count(*)::int`.as("runs"),
        sql<number>`count(*) filter (where status = 'failed')::int`.as("failed"),
        sql<number>`coalesce(sum(items_new), 0)::int`.as("items_new"),
        sql<number>`coalesce(sum(usage_usd), 0)::float`.as("usd"),
      ])
      .where(inPeriod("started_at"))
      .executeTakeFirstOrThrow(),
    db.selectFrom("ingestion_quarantine").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "pending").executeTakeFirst(),
    db.selectFrom("intel_runs").select(sql<number>`coalesce(sum(search_usd + llm_usd), 0)::float`.as("usd")).where(inPeriod("started_at")).executeTakeFirstOrThrow(),
  ]);
  const followUps = await listFollowUps(periodEnd);

  return {
    periodStart: from,
    periodEnd: to,
    candidates: candidates.map((c) => ({ ...c, score: n(c.score), ev_low_usd: n(c.ev_low_usd), ev_high_usd: n(c.ev_high_usd) })),
    actionableCount: count(actionable),
    outreach: {
      needsReview,
      drafts: n(outCounts.drafts),
      queued: n(outCounts.queued),
      exceptions: n(outCounts.failed),
      sent: n(outCounts.sent),
      replies: n(inCounts.replies),
      optOuts: n(inCounts.opt_outs),
      bounces: n(inCounts.bounces),
    },
    deals: {
      checked: n(dealCounts.checked),
      goodDeals: n(dealCounts.good),
      leadsRaised: n(dealCounts.leads),
      top: topDeals.map((d) => ({ ...d, lead_id: d.lead_id!, discount: n(d.discount), price_minor: d.price_minor === null ? null : n(d.price_minor), comp_median_minor: d.comp_median_minor === null ? null : n(d.comp_median_minor) })),
    },
    sources: {
      active: count(active),
      pausedInPeriod: paused,
      failing: failing.map((f) => ({ ...f, consecutive_failures: n(f.consecutive_failures) })),
      apifyRuns: n(apify.runs),
      apifyFailed: n(apify.failed),
      apifyItemsNew: n(apify.items_new),
      quarantinePending: count(quarantine),
    },
    spend: { intelUsd: n(intelSpend.usd), apifyUsd: n(apify.usd) },
    followUps: { ...followUpCounts(followUps), top: followUps.filter((f) => f.plan.stage !== "upcoming").slice(0, 8).map((f) => ({ id: f.id, title: f.title, stage: f.plan.stage, action: f.plan.action, next_at: f.plan.nextAt, last_touch_at: f.plan.lastTouchAt, lead_url: f.lead_url })) },
  };
}

export interface BriefRow {
  id: string;
  brief_date: string;
  period_start: string;
  period_end: string;
  headline: string;
  content: unknown;
  generated_at: string;
  delivered_at: string | null;
  delivery_error: string | null;
}

const BRIEF_COLUMNS = [
  "id",
  sql<string>`brief_date::text`.as("brief_date"),
  sql<string>`period_start::text`.as("period_start"),
  sql<string>`period_end::text`.as("period_end"),
  "headline",
  "content",
  sql<string>`generated_at::text`.as("generated_at"),
  sql<string | null>`delivered_at::text`.as("delivered_at"),
  "delivery_error",
] as const;

/**
 * Stores the brief for a local day. `replace` overwrites an existing one
 * (regenerate); otherwise an existing brief wins and null is returned, so two
 * sweeps never both deliver.
 */
export async function saveBriefing(b: { date: string; periodStart: string; periodEnd: string; headline: string; content: unknown }, opts: { replace: boolean }): Promise<BriefRow | null> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const values = { brief_date: b.date, period_start: b.periodStart, period_end: b.periodEnd, headline: b.headline, content: JSON.stringify(b.content) };
      const row = await tx
        .insertInto("briefings")
        .values(values)
        .onConflict((oc) => (opts.replace ? oc.column("brief_date").doUpdateSet({ ...values, generated_at: sql`now()` }) : oc.column("brief_date").doNothing()))
        .returning(BRIEF_COLUMNS)
        .executeTakeFirst();
      if (!row) return null;
      await enqueueEvent(tx, {
        eventName: "briefing.ready.v1",
        aggregateType: "briefing",
        aggregateId: row.id,
        idempotencyKey: `briefing.ready:${row.id}:${randomUUID()}`,
        payload: { briefingId: row.id, date: b.date },
      });
      return row as BriefRow;
    });
}

export async function markBriefingDelivered(id: string, error: string | null): Promise<void> {
  await getDb()
    .updateTable("briefings")
    .set(error ? { delivery_error: error.slice(0, 500) } : { delivered_at: sql`now()`, delivery_error: null })
    .where("id", "=", id)
    .execute();
}

export async function getBriefing(date: string): Promise<BriefRow | null> {
  const row = await getDb().selectFrom("briefings").select(BRIEF_COLUMNS).where("brief_date", "=", date).executeTakeFirst();
  return (row as BriefRow | undefined) ?? null;
}

export async function latestBriefing(): Promise<BriefRow | null> {
  const row = await getDb().selectFrom("briefings").select(BRIEF_COLUMNS).orderBy("brief_date", "desc").executeTakeFirst();
  return (row as BriefRow | undefined) ?? null;
}

export async function listBriefings(limit = 30): Promise<Pick<BriefRow, "id" | "brief_date" | "headline" | "delivered_at">[]> {
  return getDb().selectFrom("briefings").select(["id", sql<string>`brief_date::text`.as("brief_date"), "headline", sql<string | null>`delivered_at::text`.as("delivered_at")]).orderBy("brief_date", "desc").limit(limit).execute();
}
