import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** A realized result recorded against an opportunity/transaction (learning loop). */
export interface RecordOutcomeInput {
  opportunityId: string | null;
  transactionId: string | null;
  status: "won" | "lost" | "expired" | "cancelled";
  realizedAmountMinor: number | null;
  realizedProfitMinor: number | null;
  daysToClose: number | null;
  shippingCostMinor: number | null;
  currency: string;
  notes: string | null;
}

export async function recordOutcome(input: RecordOutcomeInput): Promise<{ outcomeId: string }> {
  const money = (minor: number | null) => (minor === null ? null : { amount: minor, currency: input.currency });
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("outcomes")
        .values({
          opportunity_id: input.opportunityId,
          transaction_id: input.transactionId,
          status: input.status,
          realized_amount: money(input.realizedAmountMinor),
          realized_profit: money(input.realizedProfitMinor),
          days_to_close: input.daysToClose,
          shipping_cost: money(input.shippingCostMinor),
          notes: input.notes,
          metadata_json: {},
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await enqueueEvent(tx, {
        eventName: "outcome.recorded.v1",
        aggregateType: "outcome",
        aggregateId: row.id,
        idempotencyKey: `outcome.recorded:${row.id}`,
        payload: { outcomeId: row.id, opportunityId: input.opportunityId, status: input.status },
      });
      return { outcomeId: row.id };
    });
}

/** Aggregate learning signal: win rate + counts by status (seeds score calibration). */
export async function outcomeStats(): Promise<{ total: number; won: number; winRate: number; byStatus: { status: string; count: number }[] }> {
  const rows = await getDb()
    .selectFrom("outcomes")
    .select((eb) => ["status", eb.fn.countAll<string>().as("count")])
    .groupBy("status")
    .execute();
  const byStatus = rows.map((r) => ({ status: r.status, count: Number(r.count) }));
  const total = byStatus.reduce((sum, r) => sum + r.count, 0);
  const won = byStatus.find((r) => r.status === "won")?.count ?? 0;
  return { total, won, winRate: total > 0 ? won / total : 0, byStatus };
}
