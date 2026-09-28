import type { TimelineEntry } from "@opportunity-os/contracts";
import { sql } from "kysely";
import { getDb } from "../pool";

/** Hard cap per timeline — a long-running mission can discover thousands of opportunities. */
const MAX_ENTRIES = 500;

/** Aggregates with no audit trail of their own; their history lives only in the outbox. */
const OUTBOX_ONLY_AGGREGATES = ["mission", "approval"] as const;

function iso(value: unknown): string {
  return new Date(value as string).toISOString();
}

/** "settlement.released.v1" -> "settlement.released". */
function stripVersion(eventName: string): string {
  return eventName.replace(/\.v\d+$/, "");
}

function payloadSummary(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["reason", "summary"]) {
    if (typeof p[key] === "string" && p[key]) return p[key] as string;
  }
  if (typeof p["from"] === "string" && typeof p["to"] === "string") return `${p["from"]} → ${p["to"]}`;
  if (typeof p["decision"] === "string") return `Decision: ${p["decision"]}`;
  if (Array.isArray(p["fields"])) return `Changed: ${(p["fields"] as unknown[]).join(", ")}`;
  return null;
}

async function auditEntries(entityIds: string[]): Promise<TimelineEntry[]> {
  if (entityIds.length === 0) return [];
  const rows = await getDb()
    .selectFrom("audit_events")
    .selectAll()
    .where("entity_id", "in", entityIds)
    .orderBy("created_at", "desc")
    .limit(MAX_ENTRIES)
    .execute();
  // The audit row carries no free text; a rejection's "why" lives on the opportunity.
  const rejectedIds = [...new Set(rows.filter((r) => r.action === "opportunity.rejected").map((r) => r.entity_id))];
  const reasons = new Map(
    rejectedIds.length > 0
      ? (await getDb().selectFrom("opportunities").select(["id", "rejection_reason"]).where("id", "in", rejectedIds).execute()).map((o) => [o.id, o.rejection_reason])
      : [],
  );
  return rows.map((r) => ({
    id: `audit:${r.id}`,
    at: iso(r.created_at),
    source: "audit",
    action: r.action,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    actor: r.actor_id ? `${r.actor_type}:${r.actor_id}` : r.actor_type,
    summary: reasons.get(r.entity_id) ?? null,
    hash: r.event_hash,
  }));
}

/**
 * Outbox rows for aggregates that don't write audit events. Approval rows get
 * their human-readable summary joined in — the event payload only carries ids.
 */
async function outboxEntries(aggregateIds: string[]): Promise<TimelineEntry[]> {
  if (aggregateIds.length === 0) return [];
  const rows = await getDb()
    .selectFrom("outbox as o")
    // outbox.aggregate_id is text (it holds ids of every aggregate type); approvals.id is uuid.
    .leftJoin("approvals as a", (join) => join.on(sql<boolean>`a.id::text = o.aggregate_id and o.aggregate_type = 'approval'`))
    .select([
      "o.id",
      "o.event_name",
      "o.aggregate_type",
      "o.aggregate_id",
      "o.payload",
      "o.created_at",
      "a.human_readable_summary",
      "a.entity_type as approval_entity_type",
      "a.entity_id as approval_entity_id",
    ])
    .where("o.aggregate_type", "in", [...OUTBOX_ONLY_AGGREGATES])
    .where("o.aggregate_id", "in", aggregateIds)
    .orderBy("o.created_at", "desc")
    .limit(MAX_ENTRIES)
    .execute();
  return rows.map((r) => {
    const payload = r.payload as Record<string, unknown> | null;
    const decidedBy = typeof payload?.["decidedBy"] === "string" ? (payload["decidedBy"] as string) : null;
    return {
      id: `event:${r.id}`,
      at: iso(r.created_at),
      source: "event",
      action: stripVersion(r.event_name),
      entity_type: r.aggregate_type,
      entity_id: r.aggregate_id,
      actor: decidedBy,
      summary: r.human_readable_summary ?? payloadSummary(payload),
      hash: null,
    };
  });
}

async function evidenceEntries(milestoneIds: string[]): Promise<TimelineEntry[]> {
  if (milestoneIds.length === 0) return [];
  const rows = await getDb()
    .selectFrom("evidence")
    .selectAll()
    .where("entity_type", "=", "settlement_milestone")
    .where("entity_id", "in", milestoneIds)
    .orderBy("captured_at", "desc")
    .limit(MAX_ENTRIES)
    .execute();
  return rows.map((r) => ({
    id: `evidence:${r.id}`,
    at: iso(r.captured_at),
    source: "evidence",
    action: "evidence.captured",
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    actor: r.verifier,
    summary: [r.predicate_type, r.trust_tier ? `trust ${r.trust_tier}` : null, r.source].filter(Boolean).join(" · ") || null,
    hash: r.evidence_hash,
  }));
}

function merge(...groups: TimelineEntry[][]): TimelineEntry[] {
  return groups
    .flat()
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(-MAX_ENTRIES);
}

/**
 * Everything that happened to a transaction and the objects hanging off it:
 * its opportunity + negotiations, every settlement plan/milestone (releases,
 * disputes, per-recipient payouts), milestone evidence, asset transfers, and
 * approvals raised against any of them. `undefined` if the transaction doesn't exist.
 */
export async function transactionTimeline(transactionId: string): Promise<TimelineEntry[] | undefined> {
  const db = getDb();
  const txn = await db.selectFrom("transactions").select(["id", "opportunity_id"]).where("id", "=", transactionId).executeTakeFirst();
  if (!txn) return undefined;

  const [plans, assetPlans, negotiations] = await Promise.all([
    db.selectFrom("settlement_plans").select("id").where("transaction_id", "=", transactionId).execute(),
    db.selectFrom("asset_transfer_plans").select("id").where("transaction_id", "=", transactionId).execute(),
    db.selectFrom("negotiations").select("id").where("opportunity_id", "=", txn.opportunity_id).execute(),
  ]);
  const planIds = plans.map((p) => p.id);
  const milestoneIds =
    planIds.length > 0
      ? (await db.selectFrom("settlement_milestones").select("id").where("settlement_plan_id", "in", planIds).execute()).map((m) => m.id)
      : [];

  const entityIds = [
    txn.id,
    txn.opportunity_id,
    ...planIds,
    ...milestoneIds,
    ...assetPlans.map((a) => a.id),
    ...negotiations.map((n) => n.id),
  ];
  const approvalIds = (await db.selectFrom("approvals").select("id").where("entity_id", "in", entityIds).execute()).map((a) => a.id);

  const [audit, events, evidence] = await Promise.all([auditEntries(entityIds), outboxEntries(approvalIds), evidenceEntries(milestoneIds)]);
  return merge(audit, events, evidence);
}

/**
 * A mission's history: lifecycle events (create/edit/pause/resume/archive),
 * each immutable constraints version, opportunities as they were discovered,
 * approvals raised on them, and what happened to them and any transactions
 * they became. `undefined` if the mission doesn't exist.
 */
export async function missionTimeline(missionId: string): Promise<TimelineEntry[] | undefined> {
  const db = getDb();
  const mission = await db.selectFrom("missions").select("id").where("id", "=", missionId).executeTakeFirst();
  if (!mission) return undefined;

  const [versions, opportunities] = await Promise.all([
    db.selectFrom("mission_versions").selectAll().where("mission_id", "=", missionId).orderBy("version_number", "asc").execute(),
    db
      .selectFrom("opportunities as o")
      .innerJoin("matches as m", "m.id", "o.match_id")
      .innerJoin("demands as d", "d.id", "m.demand_id")
      .where("d.mission_id", "=", missionId)
      .select(["o.id", "o.kind", "o.overall_score", "o.next_action", "o.created_at"])
      .orderBy("o.created_at", "desc")
      .limit(MAX_ENTRIES)
      .execute(),
  ]);
  const opportunityIds = opportunities.map((o) => o.id);
  const transactionIds =
    opportunityIds.length > 0
      ? (await db.selectFrom("transactions").select("id").where("opportunity_id", "in", opportunityIds).execute()).map((t) => t.id)
      : [];
  const approvalIds =
    opportunityIds.length > 0
      ? (await db.selectFrom("approvals").select("id").where("entity_id", "in", [...opportunityIds, ...transactionIds]).execute()).map((a) => a.id)
      : [];

  const versionEntries: TimelineEntry[] = versions.map((v) => ({
    id: `version:${v.id}`,
    at: iso(v.created_at),
    source: "mission_version",
    action: "mission.constraints_versioned",
    entity_type: "mission",
    entity_id: missionId,
    actor: v.changed_by,
    summary: `v${v.version_number} · ${v.change_reason}`,
    hash: null,
  }));
  const opportunityEntries: TimelineEntry[] = opportunities.map((o) => ({
    id: `opportunity:${o.id}`,
    at: iso(o.created_at),
    source: "opportunity",
    action: "opportunity.discovered",
    entity_type: "opportunity",
    entity_id: o.id,
    actor: null,
    summary: [o.kind, `score ${Number(o.overall_score).toFixed(2)}`, o.next_action].filter(Boolean).join(" · "),
    hash: null,
  }));

  const [audit, events] = await Promise.all([
    auditEntries([...opportunityIds, ...transactionIds]),
    outboxEntries([missionId, ...approvalIds]),
  ]);
  return merge(versionEntries, opportunityEntries, audit, events);
}
