import { Injectable, NotFoundException } from "@nestjs/common";
import {
  enqueueEvent,
  getDb,
  getOpportunity,
  listOpportunitiesForOperator,
} from "@opportunity-os/db";

@Injectable()
export class OpportunityService {
  list(limit?: number) {
    return listOpportunitiesForOperator(limit);
  }

  async get(id: string) {
    const opportunity = await getOpportunity(id);
    if (!opportunity) throw new NotFoundException(`Opportunity ${id} not found`);
    return opportunity;
  }

  /** Re-check availability: stamp last_verified_at and emit a verification event. */
  async reverify(id: string) {
    await this.get(id);
    const now = new Date().toISOString();
    await getDb().transaction().execute(async (tx) => {
      await tx
        .updateTable("opportunities")
        .set({ last_verified_at: now })
        .where("id", "=", id)
        .execute();
      await enqueueEvent(tx, {
        eventName: "demand.verified.v1",
        aggregateType: "opportunity",
        aggregateId: id,
        idempotencyKey: `opportunity.reverify:${id}:${now}`,
        payload: { opportunityId: id, verifiedAt: now },
      });
    });
    return this.get(id);
  }

  /** Prepare (never send) a negotiation draft for the opportunity (§13.5, §7). */
  async prepareNegotiation(id: string) {
    const opportunity = await this.get(id);
    const side = opportunity.transaction_role === "sell" ? "sell" : "buy";

    return getDb().transaction().execute(async (tx) => {
      const negotiation = await tx
        .insertInto("negotiations")
        .values({
          opportunity_id: id,
          side,
          state: "draft",
          approved_bounds_json: {},
          draft_messages_json: [],
          outbound_message_ids: [],
          offers_json: [],
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: "negotiation.draft_ready.v1",
        aggregateType: "negotiation",
        aggregateId: negotiation.id,
        idempotencyKey: `negotiation.draft_ready:${negotiation.id}`,
        payload: { opportunityId: id, negotiationId: negotiation.id, side },
      });

      return negotiation;
    });
  }
}
