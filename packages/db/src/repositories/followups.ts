import { sql, type Transaction } from "kysely";
import { compareFollowUps, followUpPlan, type FollowUpPlan, type FollowUpStage, type TouchKind } from "@opportunity-os/relationship";
import { getDb } from "../pool";
import type { Database } from "../schema";
import { appendAuditEvent } from "./audit";
import { CANDIDATE_COLUMNS } from "./intel";
import type { Actor } from "./relationships";

/**
 * Follow-ups (migration 0038, ADR-047): candidates marked contacted or
 * responded leave the Action Queue and age here. Touches are logged by hand,
 * by the status buttons, and by outreach (an approved email sent about the
 * candidate, a reply filed in its conversation). The cadence itself is
 * `followUpPlan` in @opportunity-os/relationship.
 */

export type TouchChannel = "email" | "phone" | "text" | "platform_message" | "in_person" | "other";

export interface TouchInput {
  candidateId: string;
  kind: TouchKind;
  channel?: TouchChannel | null;
  note?: string | null;
  source?: "manual" | "outreach" | "crm";
  /** The conversation message behind an outreach touch: logged once. */
  refId?: string | null;
  occurredAt?: string;
}

/**
 * Logs a touch inside the caller's transaction and moves the status along:
 * a first contact or follow-up makes an open candidate contacted, a
 * response makes an open or contacted one responded. Closed candidates
 * (won, lost, dismissed) keep their status. False when the candidate does
 * not exist or the touch was already logged.
 */
export async function logTouchTx(tx: Transaction<Database>, t: TouchInput, actor: Actor): Promise<boolean> {
  const c = await tx.selectFrom("intel_candidates").select(["id", "user_status"]).where("id", "=", t.candidateId).forUpdate().executeTakeFirst();
  if (!c) return false;
  const row = await tx
    .insertInto("candidate_touches")
    .values({
      candidate_id: t.candidateId,
      kind: t.kind,
      channel: t.channel ?? null,
      note: t.note?.trim() ? t.note.trim().slice(0, 2000) : null,
      source: t.source ?? "manual",
      ref_id: t.refId ?? null,
      ...(t.occurredAt ? { occurred_at: t.occurredAt } : {}),
      created_by: actor.type === "user" ? actor.id : null,
    })
    .onConflict((oc) => oc.column("ref_id").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!row) return false;
  const next =
    (t.kind === "contacted" || t.kind === "follow_up") && c.user_status === "open"
      ? "contacted"
      : t.kind === "responded" && (c.user_status === "open" || c.user_status === "contacted")
        ? "responded"
        : null;
  if (next) await tx.updateTable("intel_candidates").set({ user_status: next, updated_at: sql`now()` }).where("id", "=", t.candidateId).execute();
  // Doing the follow-up ends a snooze.
  else if (t.kind !== "note") await tx.updateTable("intel_candidates").set({ snoozed_until: null }).where("id", "=", t.candidateId).execute();
  await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: `intel.touch.${t.kind}`, entityType: "intel_candidate", entityId: t.candidateId });
  return true;
}

export async function logTouch(t: TouchInput, actor: Actor): Promise<boolean> {
  return getDb()
    .transaction()
    .execute((tx) => logTouchTx(tx, t, actor));
}

/** "Remind me on": hides the follow-up until then (null clears it). False when not being worked. */
export async function snoozeCandidate(id: string, until: string | null): Promise<boolean> {
  const r = await getDb().updateTable("intel_candidates").set({ snoozed_until: until }).where("id", "=", id).where("user_status", "in", ["contacted", "responded"]).returning("id").executeTakeFirst();
  return !!r;
}

export interface FollowUpTouch {
  id: string;
  kind: TouchKind;
  channel: string | null;
  note: string | null;
  source: string;
  occurred_at: string;
}

/** The candidate as the Action Queue shows it, plus its follow-up plan and touches. */
export type FollowUpItem = Awaited<ReturnType<typeof followUpRows>>[number] & {
  plan: FollowUpPlan;
  touches: FollowUpTouch[];
};

function followUpRows() {
  return getDb()
    .selectFrom("intel_candidates as c")
    .innerJoin("intel_leads as l", "l.id", "c.lead_id")
    .leftJoin("crm_links as k", (j) => j.onRef("k.subject_id", "=", "c.id").on("k.subject_type", "=", "intel_candidate").on("k.provider", "=", "pipedrive"))
    .select(CANDIDATE_COLUMNS)
    .select(["k.external_url as crm_url", "k.external_status as crm_status", "k.external_stage_id as crm_stage_id"])
    .select([sql<string | null>`c.status_changed_at::text`.as("status_changed_at"), sql<string | null>`c.snoozed_until::text`.as("snoozed_until")])
    .where("c.user_status", "in", ["contacted", "responded"])
    .limit(500)
    .execute();
}

/** Every candidate being worked with its plan, due first. */
export async function listFollowUps(now = new Date()): Promise<FollowUpItem[]> {
  const db = getDb();
  const rows = await followUpRows();
  if (!rows.length) return [];
  const touches = await db
    .selectFrom("candidate_touches")
    .select(["id", "candidate_id", "kind", "channel", "note", "source", sql<string>`occurred_at::text`.as("occurred_at")])
    .where(
      "candidate_id",
      "in",
      rows.map((r) => r.id),
    )
    .orderBy("occurred_at", "asc")
    .execute();
  const byCandidate = new Map<string, FollowUpTouch[]>();
  for (const t of touches) {
    const list = byCandidate.get(t.candidate_id) ?? [];
    list.push({ id: t.id, kind: t.kind as TouchKind, channel: t.channel, note: t.note, source: t.source, occurred_at: t.occurred_at });
    byCandidate.set(t.candidate_id, list);
  }
  const items: FollowUpItem[] = [];
  for (const r of rows) {
    const own = byCandidate.get(r.id) ?? [];
    const plan = followUpPlan({ status: r.user_status, matchKind: r.match_kind, statusChangedAt: r.status_changed_at, touches: own.map((t) => ({ kind: t.kind, at: t.occurred_at })), snoozedUntil: r.snoozed_until, now });
    if (plan) items.push({ ...r, plan, touches: own.slice(-20).reverse() });
  }
  return items.sort((a, b) => compareFollowUps(a.plan, b.plan));
}

export function followUpCounts(items: FollowUpItem[]): Record<FollowUpStage, number> {
  const counts: Record<FollowUpStage, number> = { due: 0, upcoming: 0, cold: 0, stalled: 0 };
  for (const i of items) counts[i.plan.stage]++;
  return counts;
}

/** The closed archive: won, lost and dismissed candidates, most recently closed first. */
export async function listClosedCandidates(opts: { status?: "won" | "lost" | "dismissed"; limit?: number } = {}) {
  let q = getDb()
    .selectFrom("intel_candidates as c")
    .innerJoin("intel_leads as l", "l.id", "c.lead_id")
    .select([
      "c.id",
      "c.title",
      "c.match_kind",
      "c.user_status",
      "c.outcome_reason",
      "c.outcome_note",
      sql<number | null>`c.realized_usd::float`.as("realized_usd"),
      sql<string>`coalesce(c.status_changed_at, c.updated_at)::text`.as("closed_at"),
      "l.title as lead_title",
      "l.url as lead_url",
      "l.hostname as lead_hostname",
      sql<number>`(select count(*) from candidate_touches t where t.candidate_id = c.id and t.kind in ('contacted', 'follow_up'))::int`.as("outbound_touches"),
    ])
    .where("c.user_status", "in", opts.status ? [opts.status] : ["won", "lost", "dismissed"]);
  q = q.orderBy(sql`coalesce(c.status_changed_at, c.updated_at)`, "desc");
  return q.limit(Math.min(opts.limit ?? 100, 500)).execute();
}
