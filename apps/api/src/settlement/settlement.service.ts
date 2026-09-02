import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  appendEvidence,
  disputeMilestone,
  freezeSettlementPlan,
  fundSettlementPlan,
  getMilestone,
  getSettlementPlan,
  listEvidenceLedger,
  listEvidenceClaims,
  refundMilestone,
  releaseMilestone,
  setSettlementPlanProviderRef,
  verifyMilestone,
} from "@opportunity-os/db";
import { InvalidTransitionError } from "@opportunity-os/domain";
import { evaluateCondition, decideRelease } from "@opportunity-os/escrow";
import {
  VerifierRegistry,
  makeAttestationVerifier,
  makeSignedDocumentVerifier,
} from "@opportunity-os/verifiers-sdk";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { hashReleaseTerms, hashRefundTerms } from "@opportunity-os/audit";
import { getConfig } from "@opportunity-os/config";
import type { EscrowCondition, Money, RailFamily, SettlementPlan } from "@opportunity-os/contracts";
import type { SettlementRail, SettlementService as RailService } from "@opportunity-os/settlement";
import type { Principal } from "../common/current-user";
import type {
  DisputeMilestoneBody,
  FreezeSettlementPlanBody,
  RefundMilestoneBody,
  ReleaseMilestoneBody,
  SubmitEvidenceBody,
} from "./settlement.dto";
import { createSettlementService } from "./rails";

/** Domain state-machine violations are caller errors (illegal state for the request), not server errors. */
async function guardTransition<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InvalidTransitionError) throw new ConflictException(err.message);
    throw err;
  }
}

function milestoneAmountMinor(total: Money, amount: { kind: "amount" | "percentage"; value: number }): number {
  return amount.kind === "amount" ? Math.round(amount.value) : Math.round((total.amount * amount.value) / 100);
}

@Injectable()
export class SettlementService {
  private readonly verifiers = new VerifierRegistry();
  private readonly rails: RailService = createSettlementService(getConfig());

  constructor() {
    this.verifiers.register(makeAttestationVerifier());
    this.verifiers.register(makeSignedDocumentVerifier(getConfig().security.approvalTokenSecret));
  }

  private rail(plan: { rail_family: string }): SettlementRail {
    const rails = this.rails.byFamily(plan.rail_family as RailFamily);
    if (rails.length === 0) throw new BadRequestException(`No settlement rail for family ${plan.rail_family}`);
    return rails[0]!;
  }

  /** Ensure the rail has a prepared contract/intent reference for this plan (§19). */
  private async ensurePrepared(plan: { id: string; rail_family: string; provider_ref: string | null }): Promise<string> {
    if (plan.provider_ref) return plan.provider_ref;
    const prepared = await this.rail(plan).prepare(plan as unknown as SettlementPlan);
    await setSettlementPlanProviderRef(plan.id, prepared.reference);
    return prepared.reference;
  }

  /** Prepare the rail (authorize/create intent) then move the plan to FUNDED (§20). */
  async fund(planId: string, principal: Principal) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    await this.ensurePrepared(plan);
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
    // milestone.status is narrowed to "verified" by the guard above; a disputed
    // milestone can only reach here via a dispute on its *plan* (set by
    // freeze(), or by another milestone's dispute() — both operate plan-wide).
    const disputed = plan.status === "DISPUTED" || plan.status === "FROZEN";

    const decision = decideRelease({
      humanReleasePolicy: plan.human_release_policy,
      amountMinor,
      thresholdMinor: getConfig().policy.settlementAutoReleaseThresholdMinor,
      conditionSatisfied: true,
      disputed,
      now: new Date(),
    });

    if (decision.decision === "hold") throw new ConflictException(`Release held: ${decision.reason}`);
    if (decision.decision === "auto_refund") {
      // Milestone already verified but the policy flipped to refund (e.g. a
      // deadman timeout recorded elsewhere) — execute it the same way the
      // dedicated refund path does rather than leaving funds stuck.
      return this.executeRefund(plan, milestone, principal, decision.reason);
    }

    if (decision.decision === "require_approval") {
      const payloadHash = hashReleaseTerms({ milestoneId, amountMinor, currency: total.currency });
      const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
        action: "release_milestone",
        payloadHash,
      });
      if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);
    }

    // Actually move funds on the selected rail; the release terms hash binds the
    // execution to this exact milestone + amount (§13.5).
    const reference = await this.ensurePrepared(plan);
    const execution = await this.rail(plan).execute({
      railId: this.rail(plan).railId,
      reference,
      approvalTokenHash: hashReleaseTerms({ milestoneId, amountMinor, currency: total.currency }),
      amount: { amount: amountMinor, currency: total.currency },
    });
    if (execution.status === "failed") {
      throw new ConflictException(`Rail execution failed on ${execution.railId}`);
    }

    const result = await releaseMilestone({
      milestoneId,
      amountMinor,
      currency: total.currency,
      actorId: principal.userId,
      externalTransactionRef: body.externalTransactionRef ?? execution.externalRef,
      reason: decision.reason,
    });
    return { decision, execution, ...result };
  }

  /**
   * Record a dispute: blocks release (`decideRelease` reads it back as "hold")
   * and moves the plan/milestone/transaction to DISPUTED (§20, ST-11).
   */
  async dispute(milestoneId: string, principal: Principal, body: DisputeMilestoneBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    if (milestone.status === "released" || milestone.status === "refunded") {
      throw new ConflictException(`Milestone ${milestoneId} is already ${milestone.status}`);
    }
    return guardTransition(() => disputeMilestone({ milestoneId, actorId: principal.userId, reason: body.reason }));
  }

  /** Freeze a plan: refuses further release/refund until an operator resolves it (§20, ST-11). */
  async freeze(planId: string, principal: Principal, body: FreezeSettlementPlanBody) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    return guardTransition(() => freezeSettlementPlan({ planId, actorId: principal.userId, reason: body.reason }));
  }

  /**
   * Manually refund a milestone (typically resolving a dispute) — requires a
   * token bound to this exact milestone + amount, same separation-of-duties
   * shape as release (§13.5/§14, ST-11).
   */
  async refund(milestoneId: string, principal: Principal, token: string | undefined, body: RefundMilestoneBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    if (milestone.status === "released" || milestone.status === "refunded") {
      throw new ConflictException(`Milestone ${milestoneId} is already ${milestone.status}`);
    }
    const plan = await getSettlementPlan(milestone.settlement_plan_id);
    if (!plan) throw new NotFoundException(`Settlement plan ${milestone.settlement_plan_id} not found`);

    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);
    const payloadHash = hashRefundTerms({ milestoneId, amountMinor, currency: total.currency });
    const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, token ?? "", {
      action: "refund_milestone",
      payloadHash,
    });
    if (!verified.ok) throw new ForbiddenException(`Approval token invalid: ${verified.reason}`);

    return this.executeRefund(plan, milestone, principal, body.reason);
  }

  /** Shared refund execution: rail refund (if supported) then persist REFUNDED (§19, ST-11). */
  private async executeRefund(
    plan: NonNullable<Awaited<ReturnType<typeof getSettlementPlan>>>,
    milestone: { id: string; amount_or_percentage: unknown },
    principal: Principal,
    reason: string,
  ) {
    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);

    const rail = this.rail(plan);
    let externalRefundRef: string | undefined;
    if (rail.refund) {
      const reference = await this.ensurePrepared(plan);
      const result = await rail.refund(reference, { amount: amountMinor, currency: total.currency });
      if (result.status === "failed") throw new ConflictException(`Rail refund failed on ${rail.railId}`);
      externalRefundRef = result.externalRef;
    }

    await guardTransition(() =>
      refundMilestone({
        milestoneId: milestone.id,
        actorId: principal.userId,
        externalRefundRef: externalRefundRef ?? null,
        reason,
      }),
    );
    return { decision: { decision: "auto_refund" as const, reason }, externalRefundRef };
  }
}
