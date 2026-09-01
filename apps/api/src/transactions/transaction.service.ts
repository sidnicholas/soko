import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { enqueueEvent, getApprovalById, getDb, proposeTransaction } from "@opportunity-os/db";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { getConfig } from "@opportunity-os/config";
import { hashProposalTerms } from "@opportunity-os/audit";
import type { Principal } from "../common/current-user";
import type { ProposeTransactionBody, SettlementPlanBody } from "./transaction.dto";

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

  /**
   * §11.2(10) create a proposed transaction — a binding commitment, so it is
   * gated on a valid approval token that cryptographically matches this exact
   * action + payload (§14/§22). Records an audit-backed execution event.
   */
  async propose(principal: Principal, token: string | undefined, body: ProposeTransactionBody) {
    const payloadHash = hashProposalTerms({
      opportunityId: body.opportunityId,
      grossAmountMinor: body.grossAmountMinor,
      currency: body.currency,
    });
    const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
      action: "propose_transaction",
      payloadHash,
    });
    if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);

    // Defense in depth: the approval row must still be in an approved state.
    const approval = await getApprovalById(verified.claims!.approvalId);
    if (!approval || (approval.status !== "approved" && approval.status !== "modified")) {
      throw new ForbiddenException("Approval is not in an approved state");
    }
    if (approval.entity_id !== body.opportunityId) {
      throw new ForbiddenException("Approval does not match the target opportunity");
    }

    return proposeTransaction({
      opportunityId: body.opportunityId,
      grossAmountMinor: body.grossAmountMinor,
      currency: body.currency,
      termsHash: payloadHash,
      decidedBy: principal.userId,
    });
  }
}
