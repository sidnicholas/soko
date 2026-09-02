import { z } from "zod";

/** Operator/agent request to human-gate a transaction proposal (§14). */
export const RequestApprovalSchema = z.object({
  grossAmountMinor: z.number().int().positive(),
  currency: z.string().min(3).max(12).default("USD"),
  summary: z.string().optional(),
  riskSummary: z.string().optional(),
});
export type RequestApprovalBody = z.infer<typeof RequestApprovalSchema>;

/** Operator-recorded realized result for the learning loop (§outcomes). */
export const RecordOutcomeSchema = z.object({
  status: z.enum(["won", "lost", "expired", "cancelled"]),
  transactionId: z.string().uuid().optional(),
  realizedAmountMinor: z.number().int().optional(),
  realizedProfitMinor: z.number().int().optional(),
  daysToClose: z.number().nonnegative().optional(),
  shippingCostMinor: z.number().int().optional(),
  currency: z.string().min(3).max(12).default("USD"),
  notes: z.string().optional(),
});
export type RecordOutcomeBody = z.infer<typeof RecordOutcomeSchema>;
