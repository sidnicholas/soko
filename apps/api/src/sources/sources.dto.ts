import { z } from "zod";

export const SourceReviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  permission_basis: z.enum(["none", "public_search_index", "official_api_terms", "written_permission", "provider_contract", "owner_risk_acceptance"]),
  robots_tos_assessment: z.string().trim().min(1).max(2000).nullable().optional(),
  data_use_constraints: z.string().trim().min(1).max(2000).nullable().optional(),
  /** When the review lapses; defaults to 180 days from now. */
  terms_review_due_at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
});
export type SourceReviewBody = z.infer<typeof SourceReviewSchema>;

export const SourceStatusSchema = z.object({
  status: z.enum(["active", "paused"]),
  reason: z.string().trim().min(1).max(200).nullable().optional(),
});
export type SourceStatusBody = z.infer<typeof SourceStatusSchema>;
