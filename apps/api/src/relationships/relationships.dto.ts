import { z } from "zod";

/** Request bodies for /v1/relationships (ADR-041). */
const CHANNEL_KINDS = ["email", "phone", "website", "marketplace_profile", "social", "address", "other"] as const;
const LINK_SUBJECTS = ["intel_lead", "intel_candidate", "opportunity", "offnetwork_match"] as const;
const LINK_ROLES = ["buyer", "seller", "provider", "decision_maker", "other"] as const;
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullish().transform((v) => (v ? v : null));
const iso = z.string().datetime({ offset: true });

export const ChannelSchema = z.object({
  kind: z.enum(CHANNEL_KINDS),
  value: text(500).min(1),
  label: optionalText(100),
  isPrimary: z.boolean().optional(),
  sourceLabel: z.enum(["source_fact", "inference", "unknown"]).optional(),
  sourceUrl: z.string().url().max(2000).nullish(),
});
export type ChannelBody = z.infer<typeof ChannelSchema>;

export const LinkSchema = z.object({ subjectType: z.enum(LINK_SUBJECTS), subjectId: z.string().uuid(), role: z.enum(LINK_ROLES) });
export type LinkBody = z.infer<typeof LinkSchema>;

export const CreatePartySchema = z.object({
  type: z.enum(["person", "organization"]),
  displayName: text(200).min(1),
  organizationId: z.string().uuid().nullish(),
  roleTitle: optionalText(200),
  website: optionalText(500),
  location: optionalText(200),
  sourceType: z.enum(["operator", "lead", "candidate", "crm"]).optional(),
  sourceUrl: z.string().url().max(2000).nullish(),
  channels: z.array(ChannelSchema).max(20).optional(),
  link: LinkSchema.optional(),
});
export type CreatePartyBody = z.infer<typeof CreatePartySchema>;

export const UpdatePartySchema = z.object({
  displayName: text(200).min(1).optional(),
  organizationId: z.string().uuid().nullable().optional(),
  roleTitle: text(200).nullable().optional(),
  website: text(500).nullable().optional(),
  location: text(200).nullable().optional(),
});
export type UpdatePartyBody = z.infer<typeof UpdatePartySchema>;

export const ChannelStatusSchema = z.object({ status: z.enum(["active", "invalid", "bounced"]) });

export const ConsentSchema = z
  .object({
    channelKind: z.enum(["email", "phone", "sms", "whatsapp", "any"]),
    purpose: z.enum(["outreach", "call_recording", "marketing"]),
    status: z.enum(["granted", "denied", "opted_out"]),
    basis: z.enum(["explicit", "public_business_contact", "existing_relationship", "none"]),
    evidence: optionalText(1000),
    expiresAt: iso.nullish(),
  })
  // A grant needs a basis and a note of where it came from (PRD v2 FR-07: consent is never assumed).
  .refine((c) => c.status !== "granted" || (c.basis !== "none" && !!c.evidence), { message: "A grant needs a basis and evidence", path: ["evidence"] })
  // Call recording is consented to by the person, not inferred from a public listing.
  .refine((c) => c.status !== "granted" || c.purpose !== "call_recording" || c.basis === "explicit", { message: "Call recording needs explicit consent", path: ["basis"] });
export type ConsentBody = z.infer<typeof ConsentSchema>;

export const MemorySchema = z.object({
  kind: z.enum(["fact", "preference", "commitment", "objection", "red_flag", "buying_cycle", "outcome", "note"]),
  content: text(4000).min(1),
  sourceType: z.enum(["lead", "candidate", "operator", "conversation", "call", "crm"]).default("operator"),
  sourceRef: optionalText(500),
  sourceLabel: z.enum(["source_fact", "inference", "estimate", "unknown"]).default("source_fact"),
  confidence: z.number().min(0).max(1).optional(),
  access: z.enum(["internal", "restricted"]).optional(),
  observedAt: iso.nullish(),
  expiresAt: iso.nullish(),
});
export type MemoryBody = z.infer<typeof MemorySchema>;

export const DeletePartySchema = z.object({
  /** The contact's name typed again, so a deletion is never a misclick. */
  confirmName: text(200).min(1),
});

export const ListQuerySchema = z.object({
  status: z.enum(["active", "archived"]).optional(),
  type: z.enum(["person", "organization"]).optional(),
  q: z.string().max(200).optional(),
});
