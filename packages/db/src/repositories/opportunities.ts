import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** A scored opportunity ready to persist (§11.1(8)). Money is minor units. */
export interface UpsertOpportunityInput {
  matchId: string;
  status: string;
  transactionRole: string;
  expectedRevenueMinor: number;
  expectedDirectCostMinor: number;
  expectedNetProfitMinor: number;
  capitalRequiredMinor: number;
  currency: string;
  closeProbability: number;
  timeToCashMinutes: number | null;
  repeatabilityScore: number;
  paymentCertaintyScore: number;
  fraudRiskScore: number;
  complianceRiskScore: number;
  operationalFrictionScore: number;
  customerValueScore: number;
  overallScore: number;
  scoreVersion: string;
  nextAction: string | null;
}

export interface UpsertOpportunityResult {
  opportunityId: string;
  created: boolean;
}

/**
 * Idempotent opportunity upsert keyed on match_id. First creation emits
 * opportunity.qualified.v1 so the operator dashboard and downstream workers
 * react; later re-scoring updates the row in place without re-emitting.
 */
export async function upsertOpportunity(input: UpsertOpportunityInput): Promise<UpsertOpportunityResult> {
  const money = (minor: number) => ({ amount: minor, currency: input.currency });
  const now = new Date().toISOString();

  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("opportunities")
        .values({
          match_id: input.matchId,
          status: input.status,
          transaction_role: input.transactionRole,
          expected_revenue: money(input.expectedRevenueMinor),
          expected_direct_cost: money(input.expectedDirectCostMinor),
          expected_net_profit: money(input.expectedNetProfitMinor),
          capital_required: money(input.capitalRequiredMinor),
          close_probability: input.closeProbability,
          time_to_cash_minutes: input.timeToCashMinutes,
          repeatability_score: input.repeatabilityScore,
          payment_certainty_score: input.paymentCertaintyScore,
          fraud_risk_score: input.fraudRiskScore,
          compliance_risk_score: input.complianceRiskScore,
          operational_friction_score: input.operationalFrictionScore,
          customer_value_score: input.customerValueScore,
          overall_score: input.overallScore,
          score_version: input.scoreVersion,
          next_action: input.nextAction,
          last_verified_at: now,
        })
        .onConflict((oc) =>
          oc.column("match_id").doUpdateSet({
            status: input.status,
            transaction_role: input.transactionRole,
            expected_revenue: money(input.expectedRevenueMinor),
            expected_direct_cost: money(input.expectedDirectCostMinor),
            expected_net_profit: money(input.expectedNetProfitMinor),
            capital_required: money(input.capitalRequiredMinor),
            close_probability: input.closeProbability,
            time_to_cash_minutes: input.timeToCashMinutes,
            repeatability_score: input.repeatabilityScore,
            payment_certainty_score: input.paymentCertaintyScore,
            fraud_risk_score: input.fraudRiskScore,
            compliance_risk_score: input.complianceRiskScore,
            operational_friction_score: input.operationalFrictionScore,
            customer_value_score: input.customerValueScore,
            overall_score: input.overallScore,
            score_version: input.scoreVersion,
            next_action: input.nextAction,
            last_verified_at: now,
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();

      if (row.created) {
        await enqueueEvent(tx, {
          eventName: "opportunity.qualified.v1",
          aggregateType: "opportunity",
          aggregateId: row.id,
          idempotencyKey: `opportunity.qualified:${row.id}`,
          payload: { opportunityId: row.id, matchId: input.matchId, overallScore: input.overallScore },
        });
      }

      return { opportunityId: row.id, created: row.created };
    });
}

/** Operator dashboard feed: highest-ranked opportunities first (§3.1(11), §15.2). */
export async function listOpportunitiesForOperator(limit = 50) {
  return getDb()
    .selectFrom("opportunities")
    .selectAll()
    .where("status", "in", ["qualified", "awaiting_approval", "approved"])
    .orderBy("overall_score", "desc")
    .limit(limit)
    .execute();
}

export async function listOpportunitiesByMission(missionId: string) {
  return getDb()
    .selectFrom("opportunities as o")
    .innerJoin("matches as m", "m.id", "o.match_id")
    .innerJoin("demands as d", "d.id", "m.demand_id")
    .where("d.mission_id", "=", missionId)
    .orderBy("o.overall_score", "desc")
    .selectAll("o")
    .execute();
}

export async function getOpportunity(id: string) {
  return getDb().selectFrom("opportunities").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function setOpportunityStatus(id: string, status: string): Promise<void> {
  await getDb().updateTable("opportunities").set({ status }).where("id", "=", id).execute();
}
