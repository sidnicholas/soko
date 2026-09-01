import { z } from "zod";
import { AgentType } from "./enums";

/** §8 Agent Runtime Contract — the common envelope every logical agent uses. */

export const EntityRef = z.object({
  entity_type: z.string(),
  entity_id: z.string(),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const PolicyContext = z.object({
  policy_version: z.string(),
  autonomy: z.string(),
  allowed_tools: z.array(z.string()).default([]),
  human_gated_actions: z.array(z.string()).default([]),
});
export type PolicyContext = z.infer<typeof PolicyContext>;

export const CostTelemetry = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cached_tokens: z.number().int().nonnegative().default(0),
  usd: z.number().nonnegative().default(0),
  provider: z.string().optional(),
  model: z.string().optional(),
  retries: z.number().int().nonnegative().default(0),
});
export type CostTelemetry = z.infer<typeof CostTelemetry>;

/**
 * Agents never mutate money, send negotiations, or create binding commitments
 * directly (§8). They emit ProposedActions that flow through the policy engine.
 */
export const ProposedAction = z.object({
  action_type: z.string(),
  entity_type: z.string(),
  entity_id: z.string().optional(),
  payload: z.record(z.unknown()),
  payload_hash: z.string(),
  requires_human: z.boolean().default(true),
  human_readable_summary: z.string(),
  risk_summary: z.string().optional(),
});
export type ProposedAction = z.infer<typeof ProposedAction>;

export type AgentStatus = "completed" | "needs_human" | "failed" | "retry";

export interface AgentBudget {
  maxUsd: number;
  maxTokens?: number;
  deadlineMs?: number;
}

export interface AgentTask<TInput = unknown> {
  taskId: string;
  agentType: AgentType;
  missionId?: string;
  entityRefs: EntityRef[];
  input: TInput;
  policyContext: PolicyContext;
  budget: AgentBudget;
}

export interface AgentResult<TOutput = unknown> {
  taskId: string;
  status: AgentStatus;
  output?: TOutput;
  confidence: number;
  evidenceRefs: string[];
  proposedActions: ProposedAction[];
  costTelemetry: CostTelemetry;
}
