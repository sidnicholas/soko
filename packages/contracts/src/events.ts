import { z } from "zod";
import { zId, zIso } from "./ids";
import { ActorType } from "./enums";

/** §10 — canonical, versioned V1 domain event names. */
export const EVENT_NAMES = [
  "mission.created.v1",
  "mission.updated.v1",
  "mission.paused.v1",
  "mission.archived.v1",
  "demand.created.v1",
  "demand.verified.v1",
  "demand.expired.v1",
  "supply.discovered.v1",
  "supply.updated.v1",
  "supply.unavailable.v1",
  "match.created.v1",
  "opportunity.qualified.v1",
  "opportunity.score_changed.v1",
  "opportunity.awaiting_approval.v1",
  "approval.requested.v1",
  "approval.approved.v1",
  "approval.rejected.v1",
  "negotiation.draft_ready.v1",
  "negotiation.send_requested.v1",
  "transaction.proposed.v1",
  "transaction.agreed.v1",
  "settlement.plan_created.v1",
  "settlement.funding_required.v1",
  "settlement.milestone_ready.v1",
  "settlement.release_requested.v1",
  "settlement.released.v1",
  "fulfillment.started.v1",
  "fulfillment.completed.v1",
  "transaction.disputed.v1",
  "transaction.settled.v1",
  "transaction.closed.v1",
  "risk.flagged.v1",
  "audit.integrity_failed.v1",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
export const EventNameSchema = z.enum(EVENT_NAMES);

/**
 * All events are versioned and idempotent (§10). The idempotency_key lets the
 * transactional outbox and consumers dedupe safely.
 */
export const EventEnvelope = z.object({
  id: zId,
  name: EventNameSchema,
  version: z.number().int().positive().default(1),
  occurred_at: zIso,
  actor: z.object({
    type: ActorType,
    id: z.string().nullable(),
  }),
  entity_type: z.string(),
  entity_id: z.string(),
  correlation_id: z.string().nullable(),
  mission_id: z.string().nullable(),
  idempotency_key: z.string(),
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;
