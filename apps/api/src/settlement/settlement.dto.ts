import { z } from "zod";
import { EscrowCondition, EscrowPredicateType, MilestoneRecipient } from "@opportunity-os/contracts";

/**
 * Create a milestone under a settlement plan. `optimisticAfterAt`/`deadmanAt`
 * (ST-13) are the release-engine windows: past `optimisticAfterAt` the milestone
 * becomes releasable even without full evidence; past `deadmanAt` with
 * conditions still unmet, it auto-refunds. Both are optional and independent.
 */
export const CreateMilestoneSchema = z.object({
  sequence: z.number().int().nonnegative(),
  name: z.string().min(1),
  amount: z.object({ kind: z.enum(["amount", "percentage"]), value: z.number() }),
  releaseConditions: EscrowCondition,
  requiredEvidence: z.array(z.record(z.unknown())).default([]),
  optimisticAfterAt: z.string().datetime().optional(),
  deadmanAt: z.string().datetime().optional(),
  /** ST-12 multi-party split; omit for the plan's single implicit recipient. */
  recipients: z.array(MilestoneRecipient.omit({ externalRef: true })).default([]),
});
export type CreateMilestoneBody = z.infer<typeof CreateMilestoneSchema>;

/** Submit one piece of evidence against a milestone; a verifier attests it before it enters the ledger. */
export const SubmitEvidenceSchema = z.object({
  predicateType: EscrowPredicateType,
  payload: z.record(z.unknown()).default({}),
  /** Verifier id to use; defaults to the first verifier that handles this predicate. */
  verifier: z.string().min(1).optional(),
  sourceUri: z.string().min(1).optional(),
});
export type SubmitEvidenceBody = z.infer<typeof SubmitEvidenceSchema>;

export const ReleaseMilestoneSchema = z.object({
  externalTransactionRef: z.string().min(1).optional(),
});
export type ReleaseMilestoneBody = z.infer<typeof ReleaseMilestoneSchema>;

export const DisputeMilestoneSchema = z.object({
  reason: z.string().min(1),
});
export type DisputeMilestoneBody = z.infer<typeof DisputeMilestoneSchema>;

export const FreezeSettlementPlanSchema = z.object({
  reason: z.string().min(1),
});
export type FreezeSettlementPlanBody = z.infer<typeof FreezeSettlementPlanSchema>;

export const RefundMilestoneSchema = z.object({
  externalRefundRef: z.string().min(1).optional(),
  reason: z.string().min(1),
});
export type RefundMilestoneBody = z.infer<typeof RefundMilestoneSchema>;

/** Resolve a dispute without refunding: restores the plan/milestone to whatever status they were disputed from. */
export const ResolveDisputeSchema = z.object({
  reason: z.string().min(1),
});
export type ResolveDisputeBody = z.infer<typeof ResolveDisputeSchema>;

/** Undo a freeze: restores the plan to whatever status it was frozen from. */
export const UnfreezeSettlementPlanSchema = z.object({
  reason: z.string().min(1),
});
export type UnfreezeSettlementPlanBody = z.infer<typeof UnfreezeSettlementPlanSchema>;
