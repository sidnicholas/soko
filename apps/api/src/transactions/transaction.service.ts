import { Injectable, NotFoundException } from "@nestjs/common";
import { enqueueEvent, getDb } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import type { SettlementPlanBody } from "./transaction.dto";

@Injectable()
export class TransactionService {
  private async require(id: string) {
    const transaction = await getDb()
      .selectFrom("transactions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!transaction) throw new NotFoundException(`Transaction ${id} not found`);
    return transaction;
  }

  /** Transaction aggregate with its settlement plan and ordered milestones (§20). */
  async detail(id: string) {
    const transaction = await this.require(id);
    const settlement_plan = await getDb()
      .selectFrom("settlement_plans")
      .selectAll()
      .where("transaction_id", "=", id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    const milestones = settlement_plan
      ? await getDb()
          .selectFrom("settlement_milestones")
          .selectAll()
          .where("settlement_plan_id", "=", settlement_plan.id)
          .orderBy("sequence", "asc")
          .execute()
      : [];

    return { ...transaction, settlement_plan: settlement_plan ?? null, milestones };
  }

  /** Draft a settlement plan for a transaction and link it back (§19, §20). */
  async createSettlementPlan(id: string, body: SettlementPlanBody) {
    const transaction = await this.require(id);
    const config = getConfig();

    return getDb().transaction().execute(async (tx) => {
      const plan = await tx
        .insertInto("settlement_plans")
        .values({
          transaction_id: id,
          rail_family: body.rail_family ?? "stablecoin",
          provider: body.provider ?? config.settlement.defaultStablecoinNetwork,
          asset: body.asset ?? "USDC",
          total_amount: body.total_amount ?? transaction.gross_amount,
          status: "DRAFT",
          human_release_policy: body.human_release_policy ?? "human_release_required",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await tx
        .updateTable("transactions")
        .set({ settlement_plan_id: plan.id })
        .where("id", "=", id)
        .execute();

      await enqueueEvent(tx, {
        eventName: "settlement.plan_created.v1",
        aggregateType: "settlement_plan",
        aggregateId: plan.id,
        idempotencyKey: `settlement.plan_created:${plan.id}`,
        payload: { transactionId: id, settlementPlanId: plan.id, railFamily: plan.rail_family },
      });

      return plan;
    });
  }

  /** Append-only, hash-chained history for the transaction (§21, §16 timeline). */
  async timeline(id: string) {
    await this.require(id);
    return getDb()
      .selectFrom("audit_events")
      .selectAll()
      .where("entity_id", "=", id)
      .orderBy("created_at", "asc")
      .execute();
  }
}
