import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { appendAuditEvent } from "./audit";

/** Terms for a human-approved transaction proposal (§11.2(10)). */
export interface ProposeTransactionInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  /** Hash of the exact approved payload (must match the approval token). */
  termsHash: string;
  decidedBy: string;
}

export interface ProposeTransactionResult {
  transactionId: string;
  auditEventHash: string;
}

/**
 * Create a proposed transaction from an approved opportunity, record an
 * audit-backed execution event on the hash chain, advance the opportunity, and
 * emit transaction.proposed.v1 — all in one transaction (§11.2, §21).
 */
export async function proposeTransaction(input: ProposeTransactionInput): Promise<ProposeTransactionResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const txn = await tx
        .insertInto("transactions")
        .values({
          opportunity_id: input.opportunityId,
          buyer_id: null,
          seller_id: null,
          status: "proposed",
          terms_version: 0,
          terms_hash: input.termsHash,
          gross_amount: { amount: input.grossAmountMinor, currency: input.currency },
          currency: input.currency,
          platform_revenue: null,
          settlement_plan_id: null,
          fulfillment_plan_id: null,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const audit = await appendAuditEvent(tx, {
        actorType: "operator",
        actorId: input.decidedBy,
        action: "transaction.proposed",
        entityType: "transaction",
        entityId: txn.id,
        inputHash: input.termsHash,
      });

      await tx.updateTable("opportunities").set({ status: "approved" }).where("id", "=", input.opportunityId).execute();

      await enqueueEvent(tx, {
        eventName: "transaction.proposed.v1",
        aggregateType: "transaction",
        aggregateId: txn.id,
        idempotencyKey: `transaction.proposed:${txn.id}`,
        payload: {
          transactionId: txn.id,
          opportunityId: input.opportunityId,
          termsHash: input.termsHash,
          auditEventHash: audit.event_hash,
        },
      });

      return { transactionId: txn.id, auditEventHash: audit.event_hash };
    });
}
