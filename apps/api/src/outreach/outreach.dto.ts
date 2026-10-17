import { z } from "zod";

/** Request bodies for /v1/outreach (ADR-045). */
const text = (max: number) => z.string().trim().max(max);

export const DraftSchema = z.object({
  partyId: z.string().uuid(),
  toAddress: text(320).optional(),
  subject: text(200).optional(),
  body: text(20_000).min(1),
  subjectType: z.enum(["intel_lead", "intel_candidate", "opportunity", "offnetwork_match"]).nullish(),
  subjectId: z.string().uuid().nullish(),
  conversationId: z.string().uuid().nullish(),
});
export type DraftBody = z.infer<typeof DraftSchema>;

export const EditDraftSchema = z.object({ subject: text(200).min(1).optional(), body: text(20_000).min(1).optional() });
export type EditDraftBody = z.infer<typeof EditDraftSchema>;

/** The content hash of the draft as the approver saw it. */
export const ApproveSchema = z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type ApproveBody = z.infer<typeof ApproveSchema>;

export const ResolveSchema = z.object({ outcome: z.enum(["sent", "failed", "seen"]) });
export type ResolveBody = z.infer<typeof ResolveSchema>;

export const ConversationStatusSchema = z.object({ status: z.enum(["open", "closed"]) });
export type ConversationStatusBody = z.infer<typeof ConversationStatusSchema>;
