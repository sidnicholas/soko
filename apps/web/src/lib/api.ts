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
  TimelineEntry,
} from "@opportunity-os/contracts";
import { supabase } from "./supabase";

/**
 * Typed client for the Opportunity OS API (§16). All responses are raw contract
 * entities (no envelope); lists are bare arrays. Auth is the signed-in user's
 * Supabase access token (§22); with no Supabase config it falls back to the
 * local dev `x-user-id` + `x-user-role` headers. Only ever called from client
 * components / event handlers, so a down API never breaks the build.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/v1";
export const DEV_USER_ID = process.env.NEXT_PUBLIC_DEV_USER_ID ?? "00000000-0000-4000-8000-000000000001";
export const DEV_USER_ROLE = process.env.NEXT_PUBLIC_DEV_USER_ROLE ?? "operator";

/** GET /missions/:id returns the mission flattened with its current demand spec. */
/** The caller's access to a mission (Phase 4 sharing): owner > editor > viewer. */
export type MissionAccess = "owner" | "editor" | "viewer";

export type MissionDetail = Mission & {
  demand_spec: DemandSpecification | null;
  current_version_number: number | null;
  access: MissionAccess;
};

/** GET /missions rows: missions the caller owns or was shared, with activity for the archive view. */
export type MissionListItem = Mission & {
  access: MissionAccess;
  opportunity_count: number;
  last_activity_at: string;
};

/** GET /missions/:id/rejected rows: opportunities set aside, with who/why (Phase 4 steering). */
export interface RejectedOpportunity {
  id: string;
  overall_score: number;
  rejection_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  supply_title: string;
}

export interface SteerMissionInput {
  exclude_terms: string[];
  note?: string;
}

export interface SteerMissionResult {
  mission: MissionDetail;
  steering: { versionNumber: number; addedTerms: string[]; rejectedOpportunityIds: string[] };
}

/** POST /missions/parse — a plain-language request structured for review (Phase 4 Ask). */
export interface ParsedMission {
  demand_spec: DemandSpecification;
  source: "llm" | "heuristic";
  suggested_title: string;
}

/** GET /search — missions and live opportunities the caller can see. */
export interface SearchResults {
  missions: { id: string; title: string; raw_intent: string; status: string; updated_at: string }[];
  opportunities: { id: string; status: string; overall_score: number; supply_title: string; mission_id: string; mission_title: string }[];
}

export interface MissionShare {
  id: string;
  mission_id: string;
  user_id: string;
  role: "viewer" | "editor";
  granted_by: string;
  created_at: string;
  email: string;
  display_name: string;
}

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

async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return { "x-user-id": DEV_USER_ID, "x-user-role": DEV_USER_ROLE };
  const { data } = await supabase.auth.getSession();
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const auth = await authHeaders();
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...auth,
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is it running?`);
  }
  // A rejected session (expired, revoked, deactivated) returns to the sign-in screen.
  if (res.status === 401 && supabase) void supabase.auth.signOut({ scope: "local" });
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

/** GET /me — the caller as the API sees them: verified identity + application-owned role. */
export interface Me {
  id: string;
  role: string;
  email: string | null;
}

/** AIOOS action-queue candidate (GET /intel/queue rows). numeric columns arrive as strings. */
export interface IntelFlag {
  flag: string;
  reason: string;
}
export interface IntelContact {
  channel: string;
  value: string | null;
  label: string;
}
export interface IntelCandidate {
  id: string;
  match_kind: "demand_to_supply" | "supply_to_demand" | "problem_to_service";
  title: string;
  match_rationale: string;
  verification_status: string;
  freshness: string;
  economics: {
    gross_transaction_usd: [number, number] | null;
    costs_usd: [number, number] | null;
    user_compensation_usd: [number, number];
    capital_required_usd: number;
    time_hours: [number, number];
    notes: string;
  };
  monetization: { payer: string | null; mechanism: string | null; timing: string | null; valueAdded: string | null; resolved: boolean; note: string | null };
  regulatory_flags: IntelFlag[];
  fraud_flags: IntelFlag[];
  contact: IntelContact | null;
  ev_low_usd: string;
  ev_high_usd: string;
  confidence: string;
  score: string;
  explanation: {
    factors: { name: string; points: number; note: string }[];
    modelFactors: { name: string; effect: "+" | "-"; note: string }[];
    invalidators: string[];
    probability: [number, number];
  };
  outreach: { primary: string | null; secondary: string | null };
  bucket: "act_now" | "verify_next" | "watch" | "rejected";
  reject_reason: string | null;
  user_status: string;
  outcome_reason: string | null;
  counter_url: string | null;
  counter_summary: string | null;
  service_key: string | null;
  created_at: string;
  lead_kind: string;
  lead_title: string;
  lead_summary: string;
  lead_url: string;
  lead_hostname: string;
  lead_query: string;
  lead_published_at: string | null;
  lead_age_text: string | null;
  lead_discovered_at: string;
}
export interface IntelQueue {
  act_now: IntelCandidate[];
  verify_next: IntelCandidate[];
  watch: IntelCandidate[];
  rejected: IntelCandidate[];
  stats: {
    spentTodayUsd: number;
    spentTotalUsd: number;
    runs: number;
    lastRunAt: string | null;
    leads: number;
    actionable: number;
    contacted: number;
    responded: number;
    won: number;
    realizedUsd: number;
    costPerActionableUsd: number | null;
    costPerRealizedDollar: number | null;
  };
  portfolio: { targetUsd: number; evLowUsd: number; evHighUsd: number; realizedUsd: number };
  sources: { hostname: string; orientation: string | null; leads: number; actionable: number }[];
}
export interface IntelOutcomeInput {
  status: "open" | "contacted" | "responded" | "won" | "lost" | "dismissed";
  reason?: string | null;
  realized_usd?: number | null;
}

export const api = {
  me: () => request<Me>("/me"),

  // Opportunity intelligence (AIOOS action queue)
  intelQueue: () => request<IntelQueue>("/intel/queue"),
  setIntelStatus: (id: string, body: IntelOutcomeInput) => request<IntelCandidate>(`/intel/candidates/${id}/status`, jsonBody(body)),

  // Missions (§16)
  createMission: (input: CreateMissionInput) => request<Mission>("/missions", jsonBody(input)),
  parseMission: (text: string) => request<ParsedMission>("/missions/parse", jsonBody({ text })),
  search: (q: string) => request<SearchResults>(`/search?q=${encodeURIComponent(q)}`),
  listMissions: () => request<MissionListItem[]>("/missions"),
  getMission: (id: string) => request<MissionDetail>(`/missions/${id}`),
  updateMission: (id: string, body: UpdateMissionInput) => request<MissionDetail>(`/missions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  pauseMission: (id: string) => request<Mission>(`/missions/${id}/pause`, jsonBody({})),
  resumeMission: (id: string) => request<Mission>(`/missions/${id}/resume`, jsonBody({})),
  archiveMission: (id: string) => request<Mission>(`/missions/${id}/archive`, jsonBody({})),
  steerMission: (id: string, body: SteerMissionInput) => request<SteerMissionResult>(`/missions/${id}/steer`, jsonBody(body)),
  listRejectedOpportunities: (id: string) => request<RejectedOpportunity[]>(`/missions/${id}/rejected`),
  rejectOpportunity: (id: string, reason: string) => request<Opportunity>(`/opportunities/${id}/reject`, jsonBody({ reason })),
  listMissionShares: (id: string) => request<MissionShare[]>(`/missions/${id}/shares`),
  shareMission: (id: string, email: string, role: MissionShare["role"]) => request<MissionShare[]>(`/missions/${id}/shares`, jsonBody({ email, role })),
  unshareMission: (id: string, userId: string) => request<MissionShare[]>(`/missions/${id}/shares/${userId}`, { method: "DELETE" }),
  listMissionOpportunities: (id: string) => request<Opportunity[]>(`/missions/${id}/opportunities`),
  getMissionTimeline: (id: string) => request<TimelineEntry[]>(`/missions/${id}/timeline`),

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
  getTransactionTimeline: (id: string) => request<TimelineEntry[]>(`/transactions/${id}/timeline`),
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

export type { Mission, MissionVersion, Opportunity, Approval, Transaction, SettlementPlan, SettlementMilestone, AuditEvent, Evidence, TimelineEntry };
