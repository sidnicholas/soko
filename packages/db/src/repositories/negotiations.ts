import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

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
