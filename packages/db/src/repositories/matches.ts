import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** The five §6.6 match sub-scores plus the total, as produced by the matching engine. */
export interface MatchScoreInput {
  semantic: number;
  constraint: number;
  geography: number;
  timing: number;
  quality: number;
  total: number;
  explanation: unknown;
}

export interface UpsertMatchInput extends MatchScoreInput {
  demandId: string;
  supplyId: string;
}

export interface UpsertMatchResult {
  matchId: string;
  created: boolean;
}

/**
 * Idempotent match upsert keyed on (demand_id, supply_id). First creation emits
 * match.created.v1; re-scoring on later cycles updates the sub-scores in place.
 */
export async function upsertMatch(input: UpsertMatchInput): Promise<UpsertMatchResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("matches")
        .values({
          demand_id: input.demandId,
          supply_id: input.supplyId,
          semantic_score: input.semantic,
          constraint_score: input.constraint,
          geography_score: input.geography,
          timing_score: input.timing,
          quality_score: input.quality,
          total_match_score: input.total,
          explanation_json: input.explanation,
        })
        .onConflict((oc) =>
          oc.columns(["demand_id", "supply_id"]).doUpdateSet({
            semantic_score: input.semantic,
            constraint_score: input.constraint,
            geography_score: input.geography,
            timing_score: input.timing,
            quality_score: input.quality,
            total_match_score: input.total,
            explanation_json: input.explanation,
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();

      if (row.created) {
        await enqueueEvent(tx, {
          eventName: "match.created.v1",
          aggregateType: "match",
          aggregateId: row.id,
          idempotencyKey: `match.created:${row.id}`,
          payload: { matchId: row.id, demandId: input.demandId, supplyId: input.supplyId, total: input.total },
        });
      }

      return { matchId: row.id, created: row.created };
    });
}
