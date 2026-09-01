import { z } from "zod";

export const ApprovalDecisionSchema = z.object({
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  modifications: z.record(z.unknown()).optional(),
});
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionSchema>;

export type DecisionKind = "approve" | "reject" | "modify";
