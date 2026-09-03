import type {
  Mission,
  MissionVersion,
  Opportunity,
  Approval,
  Transaction,
  SettlementPlan,
  SettlementMilestone,
  AuditEvent,
  Evidence,
  Negotiation,
  DemandSpecification,
  AutonomyPolicy,
} from "@opportunity-os/contracts";

/**
 * Typed client for the Opportunity OS API (§16). All responses are raw contract
 * entities (no envelope); lists are bare arrays. Auth in V1 is a dev shim over
 * `x-user-id` + `x-user-role` headers (§22). Only ever called from client
 * components / event handlers, so a down API never breaks the build.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/v1";
export const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? "00000000-0000-4000-8000-000000000001";
export const DEV_USER_ROLE = process.env.NEXT_PUBLIC_DEV_USER_ROLE ?? "operator";

/** GET /missions/:id returns the mission flattened with its current demand spec. */
export type MissionDetail = Mission & {
  demand_spec: DemandSpecification | null;
  current_version_number: number | null;
};

/** GET /transactions/:id aggregates the settlement plan + milestones (§20). */
export type TransactionDetail = Transaction & {
  settlement_plan: SettlementPlan | null;
  milestones: SettlementMilestone[];
};

export interface CreateMissionInput {
  title: string;
  raw_intent: string;
  agent_autonomy_policy: AutonomyPolicy;
  demand_spec: DemandSpecification;
}

export interface ApprovalDecisionInput {
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateMissionInput {
  title?: string;
  raw_intent?: string;
  agent_autonomy_policy?: AutonomyPolicy;
  demand_spec?: DemandSpecification;
}

/** Body for POST /settlement/plans/:planId/milestones — see `CreateMilestoneSchema` (§20, ST-12/ST-13). */
export interface CreateMilestoneInput {
  sequence: number;
  name: string;
  amount: { kind: "amount" | "percentage"; value: number };
  releaseConditions: Record<string, unknown>;
  requiredEvidence?: unknown[];
  optimisticAfterAt?: string;
  deadmanAt?: string;
  recipients?: { address: string; amount: { kind: "amount" | "percentage"; value: number }; counterpartyId?: string | null }[];
}

export interface SubmitEvidenceInput {
  predicateType: string;
  payload?: Record<string, unknown>;
  verifier?: string;
  sourceUri?: string;
}

export interface ReasonInput {
  reason: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-user-id": DEV_USER_ID,
        "x-user-role": DEV_USER_ROLE,
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is it running?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body?.message) detail = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A release/refund is a policy-enforced command (§13.5): the token, when present, rides the `x-approval-token` header. */
async function requestWithToken<T>(path: string, body: unknown, approvalToken?: string): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
    headers: approvalToken ? { "x-approval-token": approvalToken } : undefined,
  });
}

const jsonBody = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value ?? {}) });

export const api = {
  // Missions (§16)
  createMission: (input: CreateMissionInput) => request<Mission>("/missions", jsonBody(input)),
  listMissions: () => request<Mission[]>("/missions"),
  getMission: (id: string) => request<MissionDetail>(`/missions/${id}`),
  updateMission: (id: string, body: UpdateMissionInput) => request<MissionDetail>(`/missions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  pauseMission: (id: string) => request<Mission>(`/missions/${id}/pause`, jsonBody({})),
  resumeMission: (id: string) => request<Mission>(`/missions/${id}/resume`, jsonBody({})),
  archiveMission: (id: string) => request<Mission>(`/missions/${id}/archive`, jsonBody({})),
  listMissionOpportunities: (id: string) => request<Opportunity[]>(`/missions/${id}/opportunities`),

  // Opportunities (§16)
  listOpportunities: () => request<Opportunity[]>("/opportunities"),
  getOpportunity: (id: string) => request<Opportunity>(`/opportunities/${id}`),
  reverifyOpportunity: (id: string) => request<Opportunity>(`/opportunities/${id}/reverify`, jsonBody({})),
  prepareNegotiation: (id: string) => request<Negotiation>(`/opportunities/${id}/prepare-negotiation`, jsonBody({})),

  // Approvals (§14, §16)
  listApprovals: () => request<Approval[]>("/approvals"),
  getApproval: (id: string) => request<Approval>(`/approvals/${id}`),
  decideApproval: (id: string, decision: "approve" | "reject", body?: ApprovalDecisionInput) =>
    request<Approval>(`/approvals/${id}/${decision}`, jsonBody(body ?? {})),

  // Transactions + settlement (§16, §20)
  getTransaction: (id: string) => request<TransactionDetail>(`/transactions/${id}`),
  getTransactionTimeline: (id: string) => request<AuditEvent[]>(`/transactions/${id}/timeline`),
  createSettlementPlan: (id: string, body?: Record<string, unknown>) =>
    request<SettlementPlan>(`/transactions/${id}/settlement-plan`, jsonBody(body ?? {})),

  // Settlement plan/milestone actions (§20, UI-4)
  fundSettlementPlan: (planId: string) => request<SettlementPlan>(`/settlement/plans/${planId}/fund`, jsonBody({})),
  createMilestone: (planId: string, body: CreateMilestoneInput) =>
    request<SettlementMilestone>(`/settlement/plans/${planId}/milestones`, jsonBody(body)),
  submitEvidence: (milestoneId: string, body: SubmitEvidenceInput) =>
    request<{ evaluation: { satisfied: boolean }; verified: boolean }>(`/settlement/milestones/${milestoneId}/evidence`, jsonBody(body)),
  getEvidenceLedger: (milestoneId: string) => request<Evidence[]>(`/settlement/milestones/${milestoneId}/evidence`),
  releaseMilestone: (milestoneId: string, approvalToken?: string) =>
    requestWithToken(`/settlement/milestones/${milestoneId}/release`, {}, approvalToken),
  disputeMilestone: (milestoneId: string, body: ReasonInput) =>
    request<{ settlementPlanId: string }>(`/settlement/milestones/${milestoneId}/dispute`, jsonBody(body)),
  resolveDispute: (milestoneId: string, body: ReasonInput) =>
    request<{ settlementPlanId: string }>(`/settlement/milestones/${milestoneId}/resolve-dispute`, jsonBody(body)),
  refundMilestone: (milestoneId: string, body: ReasonInput & { externalRefundRef?: string }, approvalToken?: string) =>
    requestWithToken(`/settlement/milestones/${milestoneId}/refund`, body, approvalToken),
  freezeSettlementPlan: (planId: string, body: ReasonInput) =>
    request<void>(`/settlement/plans/${planId}/freeze`, jsonBody(body)),
  unfreezeSettlementPlan: (planId: string, body: ReasonInput) =>
    request<void>(`/settlement/plans/${planId}/unfreeze`, jsonBody(body)),
};

export type { Mission, MissionVersion, Opportunity, Approval, Transaction, SettlementPlan, SettlementMilestone, AuditEvent, Evidence };
