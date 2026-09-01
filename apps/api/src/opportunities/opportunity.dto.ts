import { z } from "zod";

/** Operator/agent request to human-gate a transaction proposal (§14). */
export const RequestApprovalSchema = z.object({
  grossAmountMinor: z.number().int().positive(),
  currency: z.string().min(3).max(12).default("USD"),
  summary: z.string().optional(),
  riskSummary: z.string().optional(),
});
export type RequestApprovalBody = z.infer<typeof RequestApprovalSchema>;
