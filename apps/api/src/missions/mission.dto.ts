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
