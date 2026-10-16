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
/** A buyer or seller as the source describes them. */
export interface OpportunityCounterparty {
  name: string;
  url?: string;
  detail?: string;
}

/** One demand or supply record behind an opportunity (packages/db `OpportunityParty`). */
export interface OpportunityParty {
  kind: "demand" | "supply";
  id: string;
  title: string;
  summary: string;
  category: string | null;
  price: { amount: number; currency: string } | null;
  price_label: "Asking price" | "Budget" | "Target price";
  quantity: number | null;
  platform: string;
  external_ref: string | null;
  url: string | null;
  location: string | null;
  counterparty: OpportunityCounterparty | null;
  condition: string | null;
  needed_by: string | null;
  availability: string;
  last_verified_at: string | null;
  created_at: string;
  mission: { id: string; title: string } | null;
  signal: { channel: string; captured_at: string } | null;
}

export interface OpportunitySide {
  role: "buyer" | "seller";
  label: string;
  note: string | null;
  parties: OpportunityParty[];
}

export interface OpportunityDetails {
  kind: string;
  sides: OpportunitySide[];
  match: {
    scores: { semantic: number; constraint: number; geography: number; timing: number; quality: number; total: number };
    rationale: string | null;
    shared_terms: string[];
    category_aligned: boolean | null;
    within_budget: boolean | null;
  } | null;
}

export type OpportunityDetail = Opportunity & { details: OpportunityDetails | null };

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
    /** Delivered-cost economics (PRD v2 FR-04); absent on candidates assessed before it existed. */
    deal?: DealEconomics;
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
/** packages/scoring deal-economics output. */
export interface DealEconomics {
  version: string;
  mode: "brokerage" | "principal" | "service";
  grossRevenueUsd: [number, number] | null;
  grossSpreadUsd: [number, number];
  costs: { kind: string; usd: [number, number]; label: "source_fact" | "estimate" | "default_assumption"; note?: string }[];
  totalCostUsd: [number, number];
  netProfitUsd: [number, number];
  capitalRequiredUsd: number;
  probability: [number, number];
  expectedProfitUsd: [number, number];
  daysToCash: [number, number];
  tier: "high" | "medium" | "low" | "marginal" | "negative";
  gates: string[];
}

export type RankingProfile = "profit_first" | "expected_value" | "fastest_cash";

export interface CandidateEvidence {
  id: string;
  kind: "source_page" | "counterpart" | "fact" | "contact" | "price_observation";
  url: string | null;
  title: string | null;
  excerpt: string | null;
  label: string;
  observed_at: string | null;
  captured_at: string;
  content_hash: string;
}

export interface IntelCandidateDetail extends IntelCandidate {
  evidence: CandidateEvidence[];
  economics_versions: { version: number; model_version: string; mode: string; tier: string; gates: string[]; created_at: string }[];
}

export interface IntelQueue {
  rank: RankingProfile;
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
  /** Per stage-1 query yield, best first. */
  queries: {
    query: string;
    searches: number;
    results: number;
    new_results: number;
    leads: number;
    assessed: number;
    actionable: number;
    last_run_at: string | null;
    /** Why results weren't leads, reason → count. */
    reasons: Record<string, number>;
  }[];
}
/** A search source added at runtime (GET /intel/sources), with what it has yielded so far. */
/** PRD v2 FR-01 source registry row, as GET /sources returns it. */
export interface RegistrySource {
  id: string;
  kind: "search_venue" | "connector" | "apify_actor";
  external_id: string | null;
  name: string;
  domain: string;
  url: string | null;
  orientation: string;
  topics: string[];
  markets: string[];
  sector: string | null;
  geography: string | null;
  access_method: string | null;
  permission_basis: PermissionBasis;
  robots_tos_assessment: string | null;
  data_use_constraints: string | null;
  terms_reviewed_at: string | null;
  terms_review_due_at: string | null;
  status: "proposed" | "active" | "paused" | "rejected";
  status_reason: string | null;
  origin: string;
  health: "unknown" | "ok" | "degraded" | "failing";
  consecutive_failures: number;
  last_run_at: string | null;
  policy_gaps: string[];
  yield: { searches: number; results: number; leads: number; actionable: number; errors: number; costUsd: number; lastRunAt: string | null } | null;
}

export type PermissionBasis = "none" | "public_search_index" | "official_api_terms" | "written_permission" | "provider_contract";

export interface RegistrySourceDetail extends RegistrySource {
  reviews: { id: string; decision: "approved" | "rejected"; permission_basis: string; robots_tos_assessment: string | null; data_use_constraints: string | null; terms_review_due_at: string | null; notes: string | null; reviewer_label: string | null; created_at: string }[];
  runs: { id: string; query: string; results: number; new_results: number; leads: number; cost_usd: number; error: string | null; created_at: string }[];
}

export interface SourceReviewInput {
  decision: "approved" | "rejected";
  permission_basis: PermissionBasis;
  robots_tos_assessment?: string | null;
  data_use_constraints?: string | null;
  terms_review_due_at?: string;
  notes?: string | null;
}

/** PRD v2 FR-02/FR-03: one lead as /supply-intelligence and /demand-intelligence return it. */
export interface IntelligenceLead {
  id: string;
  kind: "demand" | "supply" | "problem";
  title: string;
  summary: string;
  url: string;
  hostname: string;
  item: string | null;
  category: string | null;
  quantity: string | null;
  location: string | null;
  deadline: string | null;
  price_minor: number | null;
  currency: string | null;
  urgency: string | null;
  credibility: number;
  signal_type: string | null;
  evidence_level: "observed" | "inferred";
  supply_terms: { moq?: string | null; price_breaks?: string | null; condition?: string | null; shipping_terms?: string | null; expiry?: string | null; capacity?: string | null };
  title_unverified: boolean;
  discovered_at: string;
  published_at: string | null;
  last_seen_at: string;
  seen_count: number;
  status: string;
  counterpart_status: "pending" | "found" | "none_found" | "not_needed";
  counterparts: { url: string; title: string; snippet: string; hostname: string }[];
  bucket: string | null;
  reject_reason: string | null;
}

/** Inferred demand on the watchlist: a possible future buyer, never a confirmed one. */
export interface DemandHypothesis {
  id: string;
  signal_type: string;
  hypothesis: string;
  basis: string;
  source_url: string;
  hostname: string;
  item: string | null;
  location: string | null;
  confidence: number;
  check_query: string | null;
  status: "watching" | "confirmed" | "expired" | "dismissed";
  status_reason: string | null;
  revisit_at: string;
  expires_at: string;
  revisit_count: number;
  checks: { at: string; query: string; results: number; outcome: string; leadId?: string | null }[];
  confirmed_lead_id: string | null;
  created_at: string;
}

/** What POST /sources did with a submission. */
export interface SourceImport {
  received: number;
  added: number;
  added_proposed: number;
  added_paused: number;
  already_known: number;
  rejected: number;
  results: { source_id: string | null; domain: string; orientation: string | null; outcome: "added" | "already_known" | "rejected"; status: string; reason: string | null }[];
}

export type OffNetworkStatus = "open" | "contacted" | "agreed" | "won" | "lost" | "dismissed";

/** A counterparty you hold outside the network, recorded against one listing. */
export interface OffNetworkMatch {
  id: string;
  listing_id: string;
  listing_side: "demand" | "supply";
  listing_title: string;
  counterparty_name: string;
  counterparty_contact: string | null;
  terms: string | null;
  price_minor: number | null;
  currency: string | null;
  status: OffNetworkStatus;
  outcome_note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface OffNetworkInput {
  counterparty_name: string;
  counterparty_contact?: string | null;
  terms?: string | null;
  price_minor?: number | null;
  currency?: string | null;
}

/** One demand or supply record (GET /marketplace/listings), listed whether or not it was matched. */
export interface MarketListing {
  id: string;
  side: "demand" | "supply";
  origin: "intel" | "marketplace";
  type: "demand" | "supply" | "problem";
  title: string;
  description: string;
  category: string | null;
  /** Asking price (supply) or budget (demand), integer minor units. */
  price_minor: number | null;
  currency: string | null;
  quantity: string | null;
  location: string | null;
  needed_by: string | null;
  source: string;
  url: string | null;
  contact: IntelContact | null;
  matched: boolean;
  match_detail: string;
  status: string;
  off_network: OffNetworkMatch[];
  created_at: string;
}
export interface MarketListings {
  demand: MarketListing[];
  supply: MarketListing[];
  counts: Record<"demand" | "supply", { total: number; unmatched: number }>;
  /** Every off-network deal, newest first. */
  off_network: OffNetworkMatch[];
}
/** GET /analytics/yield — baseline intel spend and yield, and the opportunity funnel. */
export interface YieldReport {
  days: number;
  intelByDay: {
    day: string;
    runs: number;
    searchUsd: number;
    llmUsd: number;
    leads: number;
    candidates: number;
    actionable: number;
    costPerActionableUsd: number | null;
  }[];
  intelByProvider: { provider: string; leads: number; actionable: number; contacted: number; won: number; realizedUsd: number }[];
  opportunityFunnel: { kind: string; status: string; count: number }[];
}

export interface IntelOutcomeInput {
  status: "open" | "contacted" | "responded" | "won" | "lost" | "dismissed";
  reason?: string | null;
  realized_usd?: number | null;
}

export const api = {
  me: () => request<Me>("/me"),

  // Opportunity intelligence (AIOOS action queue)
  intelQueue: (rank: RankingProfile = "profit_first") => request<IntelQueue>(`/intel/queue?rank=${rank}`),
  intelCandidate: (id: string) => request<IntelCandidateDetail>(`/intel/candidates/${id}`),
  yieldReport: (days: number) => request<YieldReport>(`/analytics/yield?days=${days}`),
  setIntelStatus: (id: string, body: IntelOutcomeInput) => request<IntelCandidate>(`/intel/candidates/${id}/status`, jsonBody(body)),
  // Supply and demand intelligence (PRD v2 FR-02/FR-03)
  supplyIntelligence: (days: number) => request<{ leads: IntelligenceLead[] }>(`/supply-intelligence?days=${days}`),
  demandIntelligence: (days: number) => request<{ leads: IntelligenceLead[]; hypotheses: DemandHypothesis[] }>(`/demand-intelligence?days=${days}`),
  setHypothesisStatus: (id: string, status: "watching" | "dismissed") => request<{ id: string; status: string }>(`/demand-intelligence/hypotheses/${id}/status`, jsonBody({ status })),

  // Source registry (PRD v2 FR-01)
  listSources: () => request<RegistrySource[]>("/sources"),
  getSource: (id: string) => request<RegistrySourceDetail>(`/sources/${id}`),
  importSources: (document: unknown) => request<SourceImport>("/sources", jsonBody(document)),
  reviewSource: (id: string, body: SourceReviewInput) => request<RegistrySource>(`/sources/${id}/review`, jsonBody(body)),
  setSourceStatus: (id: string, status: "active" | "paused", reason?: string) => request<RegistrySource>(`/sources/${id}/status`, jsonBody({ status, reason: reason ?? null })),
  marketListings: () => request<MarketListings>("/marketplace/listings"),
  addOffNetwork: (listingId: string, body: OffNetworkInput) => request<OffNetworkMatch>(`/marketplace/listings/${encodeURIComponent(listingId)}/off-network`, jsonBody(body)),
  setOffNetworkStatus: (id: string, body: { status: OffNetworkStatus; note?: string | null }) => request<OffNetworkMatch>(`/marketplace/off-network/${id}/status`, jsonBody(body)),

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
  getOpportunity: (id: string) => request<OpportunityDetail>(`/opportunities/${id}`),
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
