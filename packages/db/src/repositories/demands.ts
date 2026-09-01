import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** A mission's current demand_spec, projected into a persisted Demand (§6.4). */
export interface UpsertMissionDemandInput {
  missionId: string;
  sourceId: string;
  description: string;
  category: string | null;
  targetPriceMinor: number | null;
  maxBudgetMinor: number | null;
  currency: string;
  urgencyScore: number;
}

export interface UpsertMissionDemandResult {
  demandId: string;
  created: boolean;
}

/**
 * Idempotent per-mission demand upsert keyed on mission_id. First creation emits
 * demand.created.v1; subsequent discovery cycles refresh the row (the mission's
 * demand_spec may have changed) without re-emitting.
 */
export async function upsertMissionDemand(input: UpsertMissionDemandInput): Promise<UpsertMissionDemandResult> {
  const now = new Date().toISOString();
  const targetPrice = input.targetPriceMinor === null ? null : { amount: input.targetPriceMinor, currency: input.currency };
  const maxBudget = input.maxBudgetMinor === null ? null : { amount: input.maxBudgetMinor, currency: input.currency };

  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("demands")
        .values({
          mission_id: input.missionId,
          source_id: input.sourceId,
          external_ref: null,
          description: input.description,
          category: input.category,
          counterparty_id: null,
          target_price: targetPrice,
          max_budget: maxBudget,
          currency: input.currency,
          quality_constraints_json: [],
          needed_by: null,
          urgency_score: input.urgencyScore,
          importance_context: null,
          payment_preferences_json: [],
          fulfillment_location: null,
          geo_point: null,
          acceptable_substitutes_json: [],
          non_negotiables_json: [],
          negotiation_limits_json: {},
          confidence: 1,
          availability_status: "active",
          last_verified_at: now,
        })
        .onConflict((oc) =>
          oc.column("mission_id").doUpdateSet({
            description: input.description,
            category: input.category,
            target_price: targetPrice,
            max_budget: maxBudget,
            currency: input.currency,
            urgency_score: input.urgencyScore,
            availability_status: "active",
            last_verified_at: now,
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();

      if (row.created) {
        await enqueueEvent(tx, {
          eventName: "demand.created.v1",
          aggregateType: "demand",
          aggregateId: row.id,
          idempotencyKey: `demand.created:${row.id}`,
          payload: { demandId: row.id, missionId: input.missionId },
        });
      }

      return { demandId: row.id, created: row.created };
    });
}
