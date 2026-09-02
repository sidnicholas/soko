import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  appendEvidence,
  fundSettlementPlan,
  getMilestone,
  getSettlementPlan,
  listEvidenceLedger,
  listEvidenceClaims,
  releaseMilestone,
  verifyMilestone,
} from "@opportunity-os/db";
import { evaluateCondition, decideRelease } from "@opportunity-os/escrow";
import {
  VerifierRegistry,
  makeAttestationVerifier,
  makeSignedDocumentVerifier,
} from "@opportunity-os/verifiers-sdk";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { hashReleaseTerms } from "@opportunity-os/audit";
import { getConfig } from "@opportunity-os/config";
import type { EscrowCondition, Money } from "@opportunity-os/contracts";
import type { Principal } from "../common/current-user";
import type { ReleaseMilestoneBody, SubmitEvidenceBody } from "./settlement.dto";

function milestoneAmountMinor(total: Money, amount: { kind: "amount" | "percentage"; value: number }): number {
  return amount.kind === "amount" ? Math.round(amount.value) : Math.round((total.amount * amount.value) / 100);
}

@Injectable()
export class SettlementService {
  private readonly verifiers = new VerifierRegistry();

  constructor() {
    this.verifiers.register(makeAttestationVerifier());
    this.verifiers.register(makeSignedDocumentVerifier(getConfig().security.approvalTokenSecret));
  }

  /** Move a DRAFT plan through funding to FUNDED (§20). */
  async fund(planId: string, principal: Principal) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    await fundSettlementPlan(planId, principal.userId);
    return getSettlementPlan(planId);
  }

  /**
   * Verify submitted evidence, append it to the hash-chained ledger, then let
   * the escrow engine decide whether the milestone's release conditions are met
   * (§escrow). Evidence is data, verified before it can move state.
   */
  async submitEvidence(milestoneId: string, body: SubmitEvidenceBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);

    const verifier = body.verifier
      ? this.verifiers.get(body.verifier)
      : this.verifiers.forPredicate(body.predicateType)[0];
    if (!verifier) throw new BadRequestException(`No verifier available for predicate ${body.predicateType}`);

    const claim = verifier.verify({
      predicateType: body.predicateType,
      payload: body.payload,
      sourceUri: body.sourceUri ?? null,
    });
    if (!claim) throw new BadRequestException("Verifier could not attest the submitted evidence");

    await appendEvidence({
      entityType: "settlement_milestone",
      entityId: milestoneId,
      claim,
      satisfies: { predicateType: body.predicateType },
    });

    const condition = milestone.release_conditions_json as EscrowCondition;
    const claims = await listEvidenceClaims("settlement_milestone", milestoneId);
    const evaluation = evaluateCondition(condition, claims);

    let verified = false;
    if (evaluation.satisfied && milestone.status === "pending") {
      await verifyMilestone(milestoneId, "system");
      verified = true;
    }
    return { evaluation, verified };
  }

  /** The hash-chained evidence ledger for a milestone (§21). */
  async evidence(milestoneId: string) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    return listEvidenceLedger("settlement_milestone", milestoneId);
  }

  /**
   * Release a verified milestone. The release engine decides auto-release
   * (below threshold) vs human approval (above); above-threshold requires a
   * valid approval token binding this exact milestone + amount (§13.5/§14).
   */
  async release(milestoneId: string, principal: Principal, token: string | undefined, body: ReleaseMilestoneBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    if (milestone.status !== "verified") throw new ConflictException(`Milestone ${milestoneId} is not verified`);

    const plan = await getSettlementPlan(milestone.settlement_plan_id);
    if (!plan) throw new NotFoundException(`Settlement plan ${milestone.settlement_plan_id} not found`);

    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);

    const decision = decideRelease({
      humanReleasePolicy: plan.human_release_policy,
      amountMinor,
      thresholdMinor: getConfig().policy.settlementAutoReleaseThresholdMinor,
      conditionSatisfied: true,
      disputed: false,
      now: new Date(),
    });

    if (decision.decision === "hold") throw new ConflictException(`Release held: ${decision.reason}`);
    if (decision.decision === "auto_refund") throw new ConflictException(`Release refunded: ${decision.reason}`);

    if (decision.decision === "require_approval") {
      const payloadHash = hashReleaseTerms({ milestoneId, amountMinor, currency: total.currency });
      const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
        action: "release_milestone",
        payloadHash,
      });
      if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);
    }

    const result = await releaseMilestone({
      milestoneId,
      amountMinor,
      currency: total.currency,
      actorId: principal.userId,
      externalTransactionRef: body.externalTransactionRef ?? null,
      reason: decision.reason,
    });
    return { decision, ...result };
  }
}
