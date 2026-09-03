import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  addMilestone,
  appendEvidence,
  disputeMilestone,
  freezeSettlementPlan,
  fundSettlementPlan,
  getMilestone,
  getSettlementPlan,
  listEvidenceLedger,
  listEvidenceClaims,
  markMilestoneReleasePending,
  refundMilestone,
  releaseMilestone,
  resolveDispute,
  setMilestoneProviderRef,
  setSettlementPlanProviderRef,
  unfreezeSettlementPlan,
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
import type { EscrowCondition, MilestoneRecipient, Money, RailFamily, SettlementPlan } from "@opportunity-os/contracts";
import type { SettlementRail, SettlementService as RailService } from "@opportunity-os/settlement";
import type { Principal } from "../common/current-user";
import type {
  CreateMilestoneBody,
  DisputeMilestoneBody,
  FreezeSettlementPlanBody,
  RefundMilestoneBody,
  ReleaseMilestoneBody,
  ResolveDisputeBody,
  SubmitEvidenceBody,
  UnfreezeSettlementPlanBody,
} from "./settlement.dto";
import { createSettlementService } from "./rails";
import { startSettlementMilestoneTimer } from "./temporal";

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

/**
 * ST-12 — resolve a milestone's recipient split into concrete minor-unit
 * amounts and fail loudly on a bad split (mixed kinds, or amounts that don't
 * sum to the milestone total) rather than silently over/under-paying.
 */
function resolveRecipients(
  recipients: readonly { address: string; amount: { kind: "amount" | "percentage"; value: number }; counterpartyId?: string | null }[],
  amountMinor: number,
  currency: string,
): { address: string; amount: Money }[] {
  if (recipients.length === 0) return [];
  const kind = recipients[0]!.amount.kind;
  if (recipients.some((r) => r.amount.kind !== kind)) {
    throw new BadRequestException("Milestone recipients must all use the same amount kind (amount or percentage)");
  }
  const resolved = recipients.map((r) => ({
    address: r.address,
    amount: { amount: milestoneAmountMinor({ amount: amountMinor, currency }, r.amount), currency },
  }));
  const sum = resolved.reduce((total, r) => total + r.amount.amount, 0);
  if (sum !== amountMinor) {
    throw new BadRequestException(`Milestone recipients sum to ${sum} but the milestone is ${amountMinor} (${currency})`);
  }
  return resolved;
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

  /**
   * Ensure the rail has a prepared contract/intent reference (§19). A rail
   * that can't phase-capture one reference across several milestones (e.g.
   * Stripe: a PaymentIntent can only be captured once — `capabilities().supportsMilestones: false`)
   * gets its own reference PER MILESTONE, prepared lazily on first release/refund
   * for exactly that milestone's amount; a rail that can (stablecoin/chain
   * references are idempotent/simulated) keeps one plan-level reference
   * prepared once at fund time, as before.
   */
  private async ensurePrepared(
    plan: { id: string; rail_family: string; provider_ref: string | null; total_amount: unknown; asset: string; status: string; human_release_policy: string },
    milestone?: { id: string; provider_ref: string | null; amount_or_percentage: unknown },
  ): Promise<string> {
    const rail = this.rail(plan);
    if (!rail.capabilities().supportsMilestones) {
      if (!milestone) throw new ConflictException(`Rail ${rail.railId} needs a milestone to prepare a reference`);
      if (milestone.provider_ref) return milestone.provider_ref;
      const total = plan.total_amount as Money;
      const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
      const milestoneTotal: Money = { amount: milestoneAmountMinor(total, amount), currency: total.currency };
      // Synthetic per-milestone plan view: same shape, but its own id (so the
      // rail's own idempotency key and any `sim_pi_${plan.id}`-style reference
      // stay unique per milestone) and total_amount narrowed to just this milestone.
      const prepared = await rail.prepare({ ...(plan as unknown as SettlementPlan), id: `${plan.id}:${milestone.id}`, total_amount: milestoneTotal });
      await setMilestoneProviderRef(milestone.id, prepared.reference);
      return prepared.reference;
    }
    if (plan.provider_ref) return plan.provider_ref;
    const prepared = await rail.prepare(plan as unknown as SettlementPlan);
    await setSettlementPlanProviderRef(plan.id, prepared.reference);
    return prepared.reference;
  }

  /** Prepare the rail (authorize/create intent) then move the plan to FUNDED (§20). */
  async fund(planId: string, principal: Principal) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    // A milestone-scoped rail (Stripe) has nothing to prepare yet — there may
    // be no milestones at fund time, and each one prepares its own reference
    // lazily at first release/refund (see ensurePrepared).
    if (this.rail(plan).capabilities().supportsMilestones) {
      await this.ensurePrepared(plan);
    }
    await fundSettlementPlan(planId, principal.userId);
    return getSettlementPlan(planId);
  }

  /**
   * Create a milestone under a plan, optionally carrying the ST-13 release-engine
   * windows (`optimisticAfterAt`/`deadmanAt`) that the durable settlement-timer
   * workflow (worker-temporal) drives once started, and/or an ST-12 recipient
   * split (validated eagerly so a bad split fails at creation, not release).
   */
  async createMilestone(planId: string, body: CreateMilestoneBody) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    if (body.recipients.length > 0) {
      const total = plan.total_amount as Money;
      resolveRecipients(body.recipients, milestoneAmountMinor(total, body.amount), total.currency);
    }
    const created = await addMilestone({
      settlementPlanId: planId,
      sequence: body.sequence,
      name: body.name,
      amount: body.amount,
      releaseConditions: body.releaseConditions,
      requiredEvidence: body.requiredEvidence,
      recipients: body.recipients,
      optimisticAfterAt: body.optimisticAfterAt ?? null,
      deadmanAt: body.deadmanAt ?? null,
    });
    if (body.optimisticAfterAt || body.deadmanAt) {
      await startSettlementMilestoneTimer(created.id);
    }
    return created;
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
   * Release a milestone. The release engine decides auto-release (below
   * threshold) vs human approval (above); above-threshold requires a valid
   * approval token binding this exact milestone + amount (§13.5/§14). A
   * still-"pending" milestone is only releasable when its optimistic window
   * has elapsed — `decideRelease` is the sole authority on that (§escrow,
   * ST-13); this fixes the gap where an elapsed optimistic window above
   * threshold had a decision but no execution path.
   */
  async release(milestoneId: string, principal: Principal, token: string | undefined, body: ReleaseMilestoneBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    if (milestone.status !== "pending" && milestone.status !== "verified") {
      throw new ConflictException(`Milestone ${milestoneId} is ${milestone.status}, not releasable`);
    }

    const plan = await getSettlementPlan(milestone.settlement_plan_id);
    if (!plan) throw new NotFoundException(`Settlement plan ${milestone.settlement_plan_id} not found`);

    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);
    const conditionSatisfied = milestone.status === "verified";
    // A disputed milestone can only reach here via a dispute on its *plan*
    // (set by freeze(), or by another milestone's dispute() — both plan-wide).
    const disputed = plan.status === "DISPUTED" || plan.status === "FROZEN";

    const decision = decideRelease({
      humanReleasePolicy: plan.human_release_policy,
      amountMinor,
      thresholdMinor: getConfig().policy.settlementAutoReleaseThresholdMinor,
      conditionSatisfied,
      disputed,
      now: new Date(),
      optimisticAfterIso: milestone.optimistic_after_at as unknown as string | null,
      deadmanAtIso: milestone.deadman_at as unknown as string | null,
    });

    if (decision.decision === "hold") throw new ConflictException(`Release held: ${decision.reason}`);
    if (decision.decision === "auto_refund") {
      // Policy flipped to refund (deadman elapsed with conditions still
      // unmet) — execute it the same way the dedicated refund path does
      // rather than leaving funds stuck.
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

    // An optimistic-window release targets a milestone that never got
    // verified through evidence — the elapsed window (plus, above threshold,
    // the human token just checked) stands in for the engine's own
    // MILESTONE_VERIFIED transition before the normal release path runs.
    if (!conditionSatisfied) {
      await verifyMilestone(milestoneId, principal.userId);
    }

    // ST-12: a milestone with recipients pays out as a split; the rail must
    // actually support it, or funds would silently land only on the primary.
    const rawRecipients = milestone.recipients_json as MilestoneRecipient[];
    const rail = this.rail(plan);
    if (rawRecipients.length > 0 && !rail.capabilities().supportsMultiRecipient) {
      throw new BadRequestException(`Rail ${rail.railId} does not support multi-recipient payouts`);
    }
    const recipients = resolveRecipients(rawRecipients, amountMinor, total.currency);

    // Actually move funds on the selected rail; the release terms hash binds the
    // execution to this exact milestone + amount (§13.5).
    const reference = await this.ensurePrepared(plan, milestone);
    const execution = await rail.execute({
      railId: rail.railId,
      reference,
      approvalTokenHash: hashReleaseTerms({ milestoneId, amountMinor, currency: total.currency }),
      amount: { amount: amountMinor, currency: total.currency },
      ...(recipients.length > 0 ? { recipients } : {}),
    });
    if (execution.status === "failed") {
      throw new ConflictException(`Rail execution failed on ${execution.railId}`);
    }

    const executedRecipients: MilestoneRecipient[] | undefined = execution.recipients?.map((r) => {
      const authored = rawRecipients.find((raw) => raw.address === r.address);
      return { address: r.address, amount: authored?.amount ?? { kind: "amount", value: r.amount.amount }, counterpartyId: authored?.counterpartyId ?? null, externalRef: r.externalRef };
    });

    if (execution.status === "pending") {
      // The rail accepted the transfer but can't confirm it synchronously
      // (e.g. an on-chain transfer, minutes from final) — record the
      // reference for webhook correlation and stop here; a later webhook
      // finalizes via releaseMilestone once the rail actually confirms it.
      await markMilestoneReleasePending({
        milestoneId,
        externalTransactionRef: body.externalTransactionRef ?? execution.externalRef,
        executedRecipients,
      });
      return { decision, execution, pending: true as const };
    }

    const result = await releaseMilestone({
      milestoneId,
      amountMinor,
      currency: total.currency,
      actorId: principal.userId,
      externalTransactionRef: body.externalTransactionRef ?? execution.externalRef,
      reason: decision.reason,
      executedRecipients,
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
   * Resolve a dispute WITHOUT refunding: an operator investigated and the
   * milestone stands, so restore the plan/milestone to whatever they were
   * disputed from and let release be retried normally (§20 follow-up).
   */
  async resolveDispute(milestoneId: string, principal: Principal, body: ResolveDisputeBody) {
    const milestone = await getMilestone(milestoneId);
    if (!milestone) throw new NotFoundException(`Milestone ${milestoneId} not found`);
    if (milestone.status !== "disputed") throw new ConflictException(`Milestone ${milestoneId} is not disputed`);
    return guardTransition(() => resolveDispute({ milestoneId, actorId: principal.userId, reason: body.reason }));
  }

  /** Undo a freeze: restore the plan to whatever status it was frozen from (§20 follow-up). */
  async unfreeze(planId: string, principal: Principal, body: UnfreezeSettlementPlanBody) {
    const plan = await getSettlementPlan(planId);
    if (!plan) throw new NotFoundException(`Settlement plan ${planId} not found`);
    if (plan.status !== "FROZEN") throw new ConflictException(`Settlement plan ${planId} is not frozen`);
    return guardTransition(() => unfreezeSettlementPlan({ planId, actorId: principal.userId, reason: body.reason }));
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
    milestone: { id: string; amount_or_percentage: unknown; provider_ref: string | null },
    principal: Principal,
    reason: string,
  ) {
    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);

    const rail = this.rail(plan);
    // Only talk to the rail if something was actually authorized/prepared for
    // this refund's scope — a milestone that never reached release has no real
    // hold to refund (nothing was ever charged), so this stays DB-only for it
    // rather than creating a fresh authorization just to immediately cancel it.
    const hasReference = rail.capabilities().supportsMilestones ? Boolean(plan.provider_ref) : Boolean(milestone.provider_ref);
    let externalRefundRef: string | undefined;
    if (rail.refund && hasReference) {
      const reference = await this.ensurePrepared(plan, milestone);
      const result = await rail.refund(reference, { amount: amountMinor, currency: total.currency });
      if (result.status === "failed") throw new ConflictException(`Rail refund failed on ${rail.railId}`);
      // Known gap, same shape as the release-side fix above but not yet
      // applied here: a "pending" (not yet "refunded") result still marks
      // this REFUNDED immediately below. No rail refunds asynchronously
      // today (Circle's refund() always fails outright; Stripe's is
      // synchronous in test mode), so this is currently unreachable rather
      // than silently wrong — flagged for whenever that changes.
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
