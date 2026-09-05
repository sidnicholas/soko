import type { NegotiationState } from "@opportunity-os/contracts";
import { assertTransition, NEGOTIATION_TRANSITIONS } from "@opportunity-os/domain";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";

/**
 * Everything the drafter needs about an opportunity's counterparty and terms,
 * joined opportunity -> match -> demand + supply (§11.2(4)).
 */
export async function getNegotiationContext(opportunityId: string) {
  return getDb()
    .selectFrom("opportunities as o")
    .innerJoin("matches as m", "m.id", "o.match_id")
    .innerJoin("demands as d", "d.id", "m.demand_id")
    .innerJoin("supply as s", "s.id", "m.supply_id")
    .where("o.id", "=", opportunityId)
    .select([
      "o.transaction_role as transactionRole",
      "s.id as supplyId",
      "d.description as demandDescription",
      "d.target_price as demandTargetPrice",
      "d.max_budget as demandMaxBudget",
      "s.title as supplyTitle",
      "s.description as supplyDescription",
      "s.price as supplyPrice",
      "s.currency as supplyCurrency",
    ])
    .executeTakeFirst();
}

export interface CreateNegotiationDraftInput {
  opportunityId: string;
  side: "buy" | "sell";
  messages: unknown;
  approvedBounds: unknown;
}

/** Persist a negotiation draft (state 'draft') and emit negotiation.draft_ready.v1. */
export async function createNegotiationDraft(input: CreateNegotiationDraftInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const negotiation = await tx
        .insertInto("negotiations")
        .values({
          opportunity_id: input.opportunityId,
          side: input.side,
          state: "draft",
          // jsonb columns: stringify so arrays of objects serialize as JSON,
          // not as a Postgres array literal (node-pg treats JS arrays specially).
          approved_bounds_json: JSON.stringify(input.approvedBounds),
          draft_messages_json: JSON.stringify(input.messages),
          outbound_message_ids: JSON.stringify([]),
          offers_json: JSON.stringify([]),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: "negotiation.draft_ready.v1",
        aggregateType: "negotiation",
        aggregateId: negotiation.id,
        idempotencyKey: `negotiation.draft_ready:${negotiation.id}`,
        payload: { opportunityId: input.opportunityId, negotiationId: negotiation.id, side: input.side },
      });

      return negotiation;
    });
}

export async function getNegotiation(id: string) {
  return getDb().selectFrom("negotiations").selectAll().where("id", "=", id).executeTakeFirst();
}

export interface SendNegotiationInput {
  negotiationId: string;
  channel: string;
  identity: string;
  text: string;
  externalRef: string | undefined;
  decidedBy: string;
  termsHash: string;
}

export interface SendNegotiationResult {
  negotiationId: string;
  state: NegotiationState;
  auditEventHash: string;
}

/**
 * §11 messaging backlog / §14 negotiation:send — record an already-dispatched
 * negotiation message: advance `draft`/`countered` -> `proposed`
 * (`NEGOTIATION_TRANSITIONS`), append the channel's message id to
 * `outbound_message_ids`, write a hash-chained audit event, emit the
 * pre-allocated `negotiation.send_requested.v1` event. Dispatch itself
 * (the actual channel API call) happens in the caller *before* this, since
 * this package has no business calling out to Telegram/Twilio/etc — this
 * function only persists that it happened (§21).
 */
export async function sendNegotiation(input: SendNegotiationInput): Promise<SendNegotiationResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const negotiation = await tx.selectFrom("negotiations").selectAll().where("id", "=", input.negotiationId).executeTakeFirstOrThrow();
      const from = negotiation.state as NegotiationState;
      assertTransition("negotiation", NEGOTIATION_TRANSITIONS, from, "proposed");

      const outboundIds = (negotiation.outbound_message_ids as string[] | null) ?? [];
      const updatedIds = input.externalRef ? [...outboundIds, input.externalRef] : outboundIds;

      await tx
        .updateTable("negotiations")
        .set({ state: "proposed", outbound_message_ids: JSON.stringify(updatedIds) })
        .where("id", "=", input.negotiationId)
        .execute();

      const audit = await appendAuditEvent(tx, {
        actorType: "operator",
        actorId: input.decidedBy,
        action: "negotiation.sent",
        entityType: "negotiation",
        entityId: input.negotiationId,
        inputHash: input.termsHash,
      });

      await enqueueEvent(tx, {
        eventName: "negotiation.send_requested.v1",
        aggregateType: "negotiation",
        aggregateId: input.negotiationId,
        idempotencyKey: `negotiation.sent:${input.negotiationId}:${input.externalRef ?? audit.event_hash}`,
        payload: {
          negotiationId: input.negotiationId,
          channel: input.channel,
          identity: input.identity,
          externalRef: input.externalRef ?? null,
          auditEventHash: audit.event_hash,
        },
      });

      return { negotiationId: input.negotiationId, state: "proposed" as const, auditEventHash: audit.event_hash };
    });
}
