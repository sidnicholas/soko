import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";

/**
 * CRM links (migration 0029, ADR-040). A subject elevated to Pipedrive gets a
 * link row before the remote deal is created, so the same subject is never
 * elevated twice; webhook events are applied once each and in order.
 * Elevation and every applied sync commit the change, an audit event and an
 * outbox event together.
 */

export type CrmProvider = "pipedrive";
export type CrmSubject = "intel_candidate" | "opportunity" | "offnetwork_match";
export type CrmStatus = "creating" | "open" | "won" | "lost" | "deleted";

export interface CrmLink {
  id: string;
  provider: CrmProvider;
  subject_type: CrmSubject;
  subject_id: string;
  external_id: string | null;
  external_url: string | null;
  external_status: CrmStatus;
  external_stage_id: number | null;
  value: number | null;
  currency: string | null;
  lost_reason: string | null;
  last_event_at: string | null;
  created_at: string;
}

const COLUMNS = [
  "id",
  "provider",
  "subject_type",
  "subject_id",
  "external_id",
  "external_url",
  "external_status",
  "external_stage_id",
  sql<number | null>`value::float`.as("value"),
  "currency",
  "lost_reason",
  sql<string | null>`last_event_at::text`.as("last_event_at"),
  sql<string>`created_at::text`.as("created_at"),
] as const;

const toLink = (r: Record<string, unknown>) => r as unknown as CrmLink;

/** A pending row older than this, with no remote deal, was left by a crash: the subject may be elevated again. */
const STALE_PENDING_MINUTES = 5;

/**
 * Reserves the subject for elevation. Returns the new pending link, or the
 * existing link when the subject is already elevated (or being elevated).
 */
export async function beginCrmLink(provider: CrmProvider, subjectType: CrmSubject, subjectId: string, elevatedBy: string | null): Promise<{ link: CrmLink; existing: boolean }> {
  const db = getDb();
  await db
    .deleteFrom("crm_links")
    .where("provider", "=", provider)
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .where("external_id", "is", null)
    .where(sql<boolean>`created_at < now() - make_interval(mins => ${STALE_PENDING_MINUTES})`)
    .execute();
  const inserted = await db
    .insertInto("crm_links")
    .values({ provider, subject_type: subjectType, subject_id: subjectId, elevated_by: elevatedBy })
    .onConflict((oc) => oc.columns(["provider", "subject_type", "subject_id"]).doNothing())
    .returning(COLUMNS)
    .executeTakeFirst();
  if (inserted) return { link: toLink(inserted), existing: false };
  const current = await db.selectFrom("crm_links").select(COLUMNS).where("provider", "=", provider).where("subject_type", "=", subjectType).where("subject_id", "=", subjectId).executeTakeFirstOrThrow();
  return { link: toLink(current), existing: true };
}

/** The remote deal could not be created: release the reservation. */
export async function abandonCrmLink(id: string): Promise<void> {
  await getDb().deleteFrom("crm_links").where("id", "=", id).where("external_id", "is", null).execute();
}

/** Records the created remote deal; emits crm.deal_elevated.v1 with an audit event. */
export async function completeCrmLink(
  id: string,
  remote: { externalId: string; externalUrl: string; status: "open" | "won" | "lost"; stageId: number | null; value: number | null; currency: string | null },
  actorId: string | null,
): Promise<CrmLink> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .updateTable("crm_links")
        .set({
          external_id: remote.externalId,
          external_url: remote.externalUrl,
          external_status: remote.status,
          external_stage_id: remote.stageId,
          value: remote.value === null ? null : remote.value.toFixed(2),
          currency: remote.currency,
          updated_at: sql`now()`,
        })
        .where("id", "=", id)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      await appendAuditEvent(tx, { actorType: "user", actorId, action: "crm.deal_elevated", entityType: row.subject_type, entityId: row.subject_id });
      await enqueueEvent(tx, {
        eventName: "crm.deal_elevated.v1",
        aggregateType: row.subject_type,
        aggregateId: row.subject_id,
        idempotencyKey: `crm.deal_elevated:${row.provider}:${remote.externalId}`,
        payload: { provider: row.provider, linkId: row.id, externalId: remote.externalId, externalUrl: remote.externalUrl, value: remote.value, currency: remote.currency },
      });
      return toLink(row);
    });
}

export async function getCrmLink(provider: CrmProvider, subjectType: CrmSubject, subjectId: string): Promise<CrmLink | undefined> {
  const row = await getDb().selectFrom("crm_links").select(COLUMNS).where("provider", "=", provider).where("subject_type", "=", subjectType).where("subject_id", "=", subjectId).executeTakeFirst();
  return row ? toLink(row) : undefined;
}

export interface CrmDealEvent {
  provider: CrmProvider;
  eventId: string;
  action: "create" | "change" | "delete";
  entityId: string;
  /** When the change happened in the CRM; an event older than the last applied one changes nothing. */
  at: string | null;
  status: "open" | "won" | "lost" | "deleted" | null;
  stageId: number | null;
  value: number | null;
  currency: string | null;
  lostReason: string | null;
}

export type CrmEventOutcome = "applied" | "duplicate" | "unknown_deal" | "stale";

/**
 * Applies one CRM webhook event. Each event id is processed once (the CRM
 * retries deliveries). A won deal marks the candidate won with the deal value
 * as realized revenue (USD only); a lost deal marks it lost with the CRM's
 * lost reason as its note; a reopened deal sets it back to contacted.
 */
export async function applyCrmDealEvent(e: CrmDealEvent): Promise<CrmEventOutcome> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const link = await tx.selectFrom("crm_links").select([...COLUMNS]).where("provider", "=", e.provider).where("external_id", "=", e.entityId).forUpdate().executeTakeFirst();
      const recorded = await tx
        .insertInto("crm_webhook_events")
        .values({ provider: e.provider, event_id: e.eventId, link_id: link?.id ?? null, action: e.action, entity_id: e.entityId })
        .onConflict((oc) => oc.columns(["provider", "event_id"]).doNothing())
        .returning("event_id")
        .executeTakeFirst();
      if (!recorded) return "duplicate";
      if (!link) return "unknown_deal";
      if (e.at && link.last_event_at && Date.parse(e.at) < Date.parse(link.last_event_at)) return "stale";

      const status: CrmStatus = e.action === "delete" ? "deleted" : (e.status ?? (link.external_status as CrmStatus));
      await tx
        .updateTable("crm_links")
        .set({
          external_status: status,
          ...(e.stageId !== null ? { external_stage_id: e.stageId } : {}),
          ...(e.value !== null ? { value: e.value.toFixed(2) } : {}),
          ...(e.currency !== null ? { currency: e.currency } : {}),
          lost_reason: status === "lost" ? e.lostReason : null,
          last_event_id: e.eventId,
          last_event_at: e.at ?? sql`now()`,
          updated_at: sql`now()`,
        })
        .where("id", "=", link.id)
        .execute();

      if (link.subject_type === "intel_candidate" && e.action !== "delete") {
        const candidate = await tx.selectFrom("intel_candidates").select(["user_status"]).where("id", "=", link.subject_id).executeTakeFirst();
        const currency = e.currency ?? link.currency;
        const value = e.value ?? link.value;
        if (candidate && status === "won" && candidate.user_status !== "won") {
          await tx
            .updateTable("intel_candidates")
            .set({
              user_status: "won",
              outcome_reason: "completed",
              realized_usd: currency === "USD" && value !== null ? Number(value).toFixed(2) : null,
              outcome_note: `Won in Pipedrive${currency && currency !== "USD" && value !== null ? ` (${value} ${currency})` : ""}`,
              updated_at: sql`now()`,
            })
            .where("id", "=", link.subject_id)
            .execute();
        } else if (candidate && status === "lost" && candidate.user_status !== "lost") {
          await tx
            .updateTable("intel_candidates")
            .set({ user_status: "lost", outcome_note: `Lost in Pipedrive${e.lostReason ? `: ${e.lostReason}` : ""}`, updated_at: sql`now()` })
            .where("id", "=", link.subject_id)
            .execute();
        } else if (candidate && status === "open" && (candidate.user_status === "won" || candidate.user_status === "lost" || candidate.user_status === "open")) {
          // In the CRM it is being worked: reopened, or newly in the pipeline.
          await tx.updateTable("intel_candidates").set({ user_status: "contacted", updated_at: sql`now()` }).where("id", "=", link.subject_id).execute();
        }
      }

      await appendAuditEvent(tx, { actorType: "service", actorId: null, action: "crm.deal_synced", entityType: link.subject_type, entityId: link.subject_id });
      await enqueueEvent(tx, {
        eventName: "crm.deal_synced.v1",
        aggregateType: link.subject_type,
        aggregateId: link.subject_id,
        idempotencyKey: `crm.deal_synced:${e.provider}:${e.eventId}:${randomUUID()}`,
        payload: { provider: e.provider, linkId: link.id, externalId: e.entityId, action: e.action, status, stageId: e.stageId, value: e.value, currency: e.currency },
      });
      return "applied";
    });
}
