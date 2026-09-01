import { Injectable, NotFoundException } from "@nestjs/common";
import {
  createApproval,
  createNegotiationDraft,
  enqueueEvent,
  getDb,
  getNegotiationContext,
  getOpportunity,
  listOpportunitiesForOperator,
} from "@opportunity-os/db";
import { draftNegotiation } from "@opportunity-os/negotiation";
import { readMoney } from "../common/money";
import { getConfig } from "@opportunity-os/config";
import { hashProposalTerms } from "@opportunity-os/audit";
import type { Principal } from "../common/current-user";
import type { RequestApprovalBody } from "./opportunity.dto";

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

  /** Prepare (never send) an LLM-drafted negotiation for the opportunity (§13.5, §11.2). */
  async prepareNegotiation(id: string) {
    await this.get(id);
    const ctx = await getNegotiationContext(id);
    if (!ctx) throw new NotFoundException(`Opportunity ${id} has no match context to negotiate`);

    const side = ctx.transactionRole === "seller" ? "sell" : "buy";
    const supply = readMoney(ctx.supplyPrice);
    const budget = readMoney(ctx.demandMaxBudget) ?? readMoney(ctx.demandTargetPrice);
    const currency = supply?.currency ?? ctx.supplyCurrency ?? "USD";

    const draft = await draftNegotiation({
      side,
      itemTitle: ctx.supplyTitle,
      itemDescription: ctx.supplyDescription,
      targetPriceMinor: supply?.amountMinor ?? null,
      maxAmountMinor: budget?.amountMinor ?? null,
      currency,
    });

    return createNegotiationDraft({
      opportunityId: id,
      side,
      messages: draft.messages,
      approvedBounds: draft.approvedBounds,
    });
  }

  /**
   * §14 request a human gate for proposing a transaction on this opportunity.
   * Hashes the exact proposed terms so the approval — and the token minted on
   * approval — binds to precisely this command.
   */
  async requestApproval(id: string, principal: Principal, body: RequestApprovalBody) {
    await this.get(id);
    return createApproval({
      requestedByAgent: principal.userId,
      actionType: "propose_transaction",
      entityType: "opportunity",
      entityId: id,
      payloadHash: hashProposalTerms({ opportunityId: id, grossAmountMinor: body.grossAmountMinor, currency: body.currency }),
      humanReadableSummary:
        body.summary ?? `Propose a transaction for opportunity ${id} at ${body.grossAmountMinor} ${body.currency} (minor units)`,
      riskSummary: body.riskSummary ?? null,
      expiresAt: new Date(Date.now() + getConfig().policy.approvalTimeoutMinutes * 60_000).toISOString(),
    });
  }
}
