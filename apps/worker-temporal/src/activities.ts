/**
 * Temporal activity surface. Discovery lives in @opportunity-os/discovery so the
 * lifecycle worker and the discovery workflow share one implementation. The
 * execution activities below wrap the same approval/proposal repos + token
 * crypto the HTTP path uses, so the durable path and the synchronous path are
 * behaviourally identical (§11.2, §14).
 */
import {
  createApproval,
  getApprovalById,
  getMilestone,
  getSettlementPlan,
  proposeTransaction,
  refundMilestone,
  releaseMilestone,
  setMilestoneProviderRef,
  setSettlementPlanProviderRef,
  verifyMilestone,
} from "@opportunity-os/db";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { hashProposalTerms, hashReleaseTerms } from "@opportunity-os/audit";
import { getConfig, type AppConfig } from "@opportunity-os/config";
import { decideRelease } from "@opportunity-os/escrow";
import { SettlementService, StripeFiatRail, StablecoinRail, type SettlementRail } from "@opportunity-os/settlement";
import { ProgrammableSettlementAdapter } from "@opportunity-os/chain";
import type { Money, RailFamily, SettlementPlan } from "@opportunity-os/contracts";

export { runDiscoveryCycle } from "@opportunity-os/discovery";
export type { DiscoveryInput, DiscoveryResult, DiscoveryDemand } from "@opportunity-os/discovery";

export interface RequestApprovalActivityInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  requestedByAgent: string;
  approvalTimeoutMinutes: number;
}

/** §11.2(5) create the human-gate request; returns the id the workflow tracks. */
export async function requestApprovalActivity(input: RequestApprovalActivityInput): Promise<{ approvalId: string; payloadHash: string }> {
  const payloadHash = hashProposalTerms({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
  });
  const approval = await createApproval({
    requestedByAgent: input.requestedByAgent,
    actionType: "propose_transaction",
    entityType: "opportunity",
    entityId: input.opportunityId,
    payloadHash,
    humanReadableSummary: `Propose a transaction for opportunity ${input.opportunityId} at ${input.grossAmountMinor} ${input.currency} (minor units)`,
    riskSummary: null,
    expiresAt: new Date(Date.now() + input.approvalTimeoutMinutes * 60_000).toISOString(),
  });
  return { approvalId: approval.id, payloadHash };
}

export interface ExecuteProposalActivityInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  decidedBy: string;
  token: string;
}

/**
 * §11.2(7,10) execute the approved action: verify the token cryptographically
 * (same check as the HTTP propose endpoint), confirm the approval is approved,
 * then create the proposed transaction with an audit-backed event. Throws so
 * Temporal surfaces a failed activity if authorization does not hold.
 */
export async function executeProposalActivity(input: ExecuteProposalActivityInput): Promise<{ transactionId: string }> {
  const payloadHash = hashProposalTerms({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
  });
  const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, input.token, {
    action: "propose_transaction",
    payloadHash,
  });
  if (!verified.ok) throw new Error(`approval token invalid: ${verified.reason}`);

  const approval = await getApprovalById(verified.claims!.approvalId);
  if (!approval || (approval.status !== "approved" && approval.status !== "modified")) {
    throw new Error("approval is not in an approved state");
  }

  const result = await proposeTransaction({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
    termsHash: payloadHash,
    decidedBy: input.decidedBy,
  });
  return { transactionId: result.transactionId };
}

/**
 * Rail composition (§19/§29), duplicated from apps/api/src/settlement/rails.ts:
 * only the app layer may depend on both the settlement abstraction and the
 * on-chain adapter, and worker-temporal is a second such app (same reasoning
 * as executeProposalActivity mirroring the HTTP propose path above).
 */
function createSettlementService(config: AppConfig): SettlementService {
  const service = new SettlementService();
  service.register(new StripeFiatRail(config.settlement.stripeSecretKey));
  service.register(new StablecoinRail(config.settlement.defaultStablecoinNetwork));
  service.register(new ProgrammableSettlementAdapter(config.settlement.chainRpcUrl ? "testnet" : "local"));
  return service;
}

function railFor(rails: SettlementService, plan: { rail_family: string }): SettlementRail {
  const found = rails.byFamily(plan.rail_family as RailFamily);
  if (found.length === 0) throw new Error(`No settlement rail for family ${plan.rail_family}`);
  return found[0]!;
}

function milestoneAmountMinor(total: Money, amount: { kind: "amount" | "percentage"; value: number }): number {
  return amount.kind === "amount" ? Math.round(amount.value) : Math.round((total.amount * amount.value) / 100);
}

/**
 * Mirrors apps/api/src/settlement/settlement.service.ts's ensurePrepared (see
 * that file's comment): a rail that can't phase-capture one reference across
 * several milestones (Stripe — a PaymentIntent captures once) gets its own
 * reference per milestone, prepared lazily for exactly that milestone's
 * amount; a rail that can (stablecoin/chain) uses the one plan-level
 * reference prepared at fund time.
 */
async function ensurePrepared(
  rail: SettlementRail,
  plan: { id: string; provider_ref: string | null; total_amount: unknown; asset: string; status: string; human_release_policy: string },
  milestone: { id: string; provider_ref: string | null; amount_or_percentage: unknown },
): Promise<string> {
  if (!rail.capabilities().supportsMilestones) {
    if (milestone.provider_ref) return milestone.provider_ref;
    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const milestoneTotal: Money = { amount: milestoneAmountMinor(total, amount), currency: total.currency };
    const prepared = await rail.prepare({ ...(plan as unknown as SettlementPlan), id: `${plan.id}:${milestone.id}`, total_amount: milestoneTotal });
    await setMilestoneProviderRef(milestone.id, prepared.reference);
    return prepared.reference;
  }
  if (plan.provider_ref) return plan.provider_ref;
  const prepared = await rail.prepare(plan as unknown as SettlementPlan);
  await setSettlementPlanProviderRef(plan.id, prepared.reference);
  return prepared.reference;
}

/** ST-12 — mirrors apps/api/src/settlement/settlement.service.ts's resolveRecipients (see that file's comment on why it's duplicated). */
function resolveRecipients(
  recipients: readonly { address: string; amount: { kind: "amount" | "percentage"; value: number } }[],
  amountMinor: number,
  currency: string,
): { address: string; amount: Money }[] {
  if (recipients.length === 0) return [];
  const kind = recipients[0]!.amount.kind;
  if (recipients.some((r) => r.amount.kind !== kind)) {
    throw new Error("Milestone recipients must all use the same amount kind (amount or percentage)");
  }
  const resolved = recipients.map((r) => ({
    address: r.address,
    amount: { amount: milestoneAmountMinor({ amount: amountMinor, currency }, r.amount), currency },
  }));
  const sum = resolved.reduce((total, r) => total + r.amount.amount, 0);
  if (sum !== amountMinor) {
    throw new Error(`Milestone recipients sum to ${sum} but the milestone is ${amountMinor} (${currency})`);
  }
  return resolved;
}

export type MilestoneTimerAction = "none" | "waiting" | "held" | "refunded" | "released";

export interface MilestoneTimerResult {
  action: MilestoneTimerAction;
  /** Raw windows so the workflow can compute its next sleep when still "waiting". */
  optimisticAfterIso?: string | null;
  deadmanAtIso?: string | null;
}

/**
 * §20/ST-13 — one durable-timer tick for a milestone: re-reads real state, asks
 * the (pure, versioned) release engine what to do, and executes it exactly like
 * the manual release/refund HTTP paths do. Deadman auto-refund and
 * below-threshold optimistic auto-release require no human token, mirroring
 * `SettlementService.release()`'s own auto_refund/auto_release branches — only
 * `require_approval` needs a human, which this activity cannot supply, so it
 * reports "held" and stops (§13.5: no self-authorized money above threshold).
 */
export async function checkMilestoneTimerActivity(milestoneId: string): Promise<MilestoneTimerResult> {
  const milestone = await getMilestone(milestoneId);
  if (!milestone || milestone.status === "released" || milestone.status === "refunded") {
    return { action: "none" };
  }
  const plan = await getSettlementPlan(milestone.settlement_plan_id);
  if (!plan) return { action: "none" };

  const optimisticAfterIso = milestone.optimistic_after_at as unknown as string | null;
  const deadmanAtIso = milestone.deadman_at as unknown as string | null;
  const disputed = plan.status === "DISPUTED" || plan.status === "FROZEN";
  const conditionSatisfied = milestone.status === "verified";
  const total = plan.total_amount as Money;
  const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
  const amountMinor = milestoneAmountMinor(total, amount);

  const decision = decideRelease({
    humanReleasePolicy: plan.human_release_policy,
    amountMinor,
    thresholdMinor: getConfig().policy.settlementAutoReleaseThresholdMinor,
    conditionSatisfied,
    disputed,
    now: new Date(),
    optimisticAfterIso,
    deadmanAtIso,
  });

  if (decision.decision === "hold") {
    return disputed ? { action: "held" } : { action: "waiting", optimisticAfterIso, deadmanAtIso };
  }
  if (decision.decision === "require_approval") {
    return { action: "held" };
  }

  const rails = createSettlementService(getConfig());
  const rail = railFor(rails, plan);

  if (decision.decision === "auto_refund") {
    // Only talk to the rail if something was actually authorized for this
    // milestone/plan — a milestone that never reached release has no real
    // hold to refund.
    const hasReference = rail.capabilities().supportsMilestones ? Boolean(plan.provider_ref) : Boolean(milestone.provider_ref);
    let externalRefundRef: string | undefined;
    if (rail.refund && hasReference) {
      const reference = await ensurePrepared(rail, plan, milestone);
      const result = await rail.refund(reference, { amount: amountMinor, currency: total.currency });
      if (result.status === "failed") throw new Error(`Rail refund failed on ${rail.railId}`);
      externalRefundRef = result.externalRef;
    }
    await refundMilestone({
      milestoneId,
      actorId: "system",
      externalRefundRef: externalRefundRef ?? null,
      reason: decision.reason,
    });
    return { action: "refunded" };
  }

  // auto_release: an optimistic-window release may target a milestone that
  // never got verified through evidence — treat the window elapsing as the
  // engine's own verification (§escrow) before running the normal release path.
  if (!conditionSatisfied) {
    await verifyMilestone(milestoneId, "system");
  }
  const rawRecipients = milestone.recipients_json as { address: string; amount: { kind: "amount" | "percentage"; value: number }; counterpartyId?: string | null }[];
  if (rawRecipients.length > 0 && !rail.capabilities().supportsMultiRecipient) {
    throw new Error(`Rail ${rail.railId} does not support multi-recipient payouts`);
  }
  const recipients = resolveRecipients(rawRecipients, amountMinor, total.currency);

  const reference = await ensurePrepared(rail, plan, milestone);
  const execution = await rail.execute({
    railId: rail.railId,
    reference,
    approvalTokenHash: hashReleaseTerms({ milestoneId, amountMinor, currency: total.currency }),
    amount: { amount: amountMinor, currency: total.currency },
    ...(recipients.length > 0 ? { recipients } : {}),
  });
  if (execution.status === "failed") throw new Error(`Rail execution failed on ${execution.railId}`);

  const executedRecipients = execution.recipients?.map((r) => {
    const authored = rawRecipients.find((raw) => raw.address === r.address);
    return { address: r.address, amount: authored?.amount ?? { kind: "amount" as const, value: r.amount.amount }, counterpartyId: authored?.counterpartyId ?? null, externalRef: r.externalRef };
  });

  await releaseMilestone({
    milestoneId,
    amountMinor,
    currency: total.currency,
    actorId: "system",
    externalTransactionRef: execution.externalRef,
    reason: decision.reason,
    executedRecipients,
  });
  return { action: "released" };
}
