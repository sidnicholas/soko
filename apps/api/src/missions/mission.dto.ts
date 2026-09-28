import { z } from "zod";
import { AutonomyPolicy, DemandSpecification } from "@opportunity-os/contracts";

export const MissionCreateSchema = z.object({
  title: z.string().min(1),
  raw_intent: z.string().min(1),
  agent_autonomy_policy: AutonomyPolicy,
  demand_spec: DemandSpecification.optional(),
});
export type MissionCreateBody = z.infer<typeof MissionCreateSchema>;

export const MissionUpdateSchema = z
  .object({
    title: z.string().min(1).optional(),
    raw_intent: z.string().min(1).optional(),
    agent_autonomy_policy: AutonomyPolicy.optional(),
    demand_spec: DemandSpecification.optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.raw_intent !== undefined ||
      body.agent_autonomy_policy !== undefined ||
      body.demand_spec !== undefined,
    { message: "Provide at least one editable field" },
  );
export type MissionUpdateBody = z.infer<typeof MissionUpdateSchema>;

/** Lifecycle action -> target mission status (§6.2 mission state guard). */
export type MissionAction = "pause" | "resume" | "archive";

/** Phase 4 sharing — grant a user access to a mission by their account email. */
export const MissionShareSchema = z.object({
  email: z.string().email(),
  role: z.enum(["viewer", "editor"]),
});
export type MissionShareBody = z.infer<typeof MissionShareSchema>;

/** Phase 4 user→agent steering: terms the agent must stop matching, plus an optional note for the record. */
export const MissionSteerSchema = z
  .object({
    exclude_terms: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((b) => b.exclude_terms.length > 0 || (b.note ?? "").length > 0, { message: "Provide exclude_terms or a note" });
export type MissionSteerBody = z.infer<typeof MissionSteerSchema>;

/** Setting an opportunity aside always carries the reason — it's what the agent (and collaborators) learn from. */
export const OpportunityRejectSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type OpportunityRejectBody = z.infer<typeof OpportunityRejectSchema>;

/** Phase 4 Ask: structure a plain-language request for review before a mission is created. */
export const MissionParseSchema = z.object({ text: z.string().trim().min(1).max(4000) });
export type MissionParseBody = z.infer<typeof MissionParseSchema>;
