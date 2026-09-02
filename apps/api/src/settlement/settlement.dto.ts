import { z } from "zod";
import { EscrowPredicateType } from "@opportunity-os/contracts";

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
