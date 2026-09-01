import { z } from "zod";
import { zId, zIso, zHash } from "./ids";
import { Money } from "./money";
import { GeoPoint, GeoLocation } from "./geo";
import { Constraint, DemandSpecification } from "./demand-spec";
import {
  UserRole,
  UserStatus,
  TrustTier,
  MissionStatus,
  AvailabilityStatus,
  OpportunityStatus,
  TransactionStatus,
  RailFamily,
  SettlementStatus,
  ApprovalStatus,
  ApprovalDecision,
  ActorType,
  CounterpartyType,
  NegotiationSide,
  NegotiationState,
  AutonomyPolicy,
  PaymentMethodFamily,
} from "./enums";

/** §6.1 */
export const User = z.object({
  id: zId,
  email: z.string().email(),
  display_name: z.string(),
  role: UserRole,
  trust_tier: TrustTier,
  status: UserStatus,
  created_at: zIso,
  updated_at: zIso,
});
export type User = z.infer<typeof User>;

/** §6.2 — persistent user search/request. */
export const Mission = z.object({
  id: zId,
  owner_user_id: zId,
  title: z.string(),
  raw_intent: z.string(),
  status: MissionStatus,
  current_version_id: zId.nullable(),
  agent_autonomy_policy: AutonomyPolicy,
  created_at: zIso,
  updated_at: zIso,
  archived_at: zIso.nullable(),
});
export type Mission = z.infer<typeof Mission>;

/** §6.3 — immutable snapshot of mission constraints. */
export const MissionVersion = z.object({
  id: zId,
  mission_id: zId,
  version_number: z.number().int().nonnegative(),
  demand_spec_json: DemandSpecification,
  changed_by: zId,
  change_reason: z.string(),
  created_at: zIso,
});
export type MissionVersion = z.infer<typeof MissionVersion>;

/** §6.4 */
export const Demand = z.object({
  id: zId,
  mission_id: zId.nullable(),
  source_id: z.string(),
  external_ref: z.string().nullable(),
  description: z.string(),
  category: z.string().nullable(),
  counterparty_id: zId.nullable(),
  target_price: Money.nullable(),
  max_budget: Money.nullable(),
  currency: z.string(),
  quality_constraints_json: z.array(Constraint).default([]),
  needed_by: zIso.nullable(),
  urgency_score: z.number().min(0).max(1),
  importance_context: z.string().nullable(),
  payment_preferences_json: z.array(PaymentMethodFamily).default([]),
  fulfillment_location: GeoLocation.nullable(),
  geo_point: GeoPoint.nullable(),
  acceptable_substitutes_json: z.array(z.string()).default([]),
  non_negotiables_json: z.array(Constraint).default([]),
  negotiation_limits_json: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  availability_status: AvailabilityStatus,
  last_verified_at: zIso.nullable(),
  created_at: zIso,
});
export type Demand = z.infer<typeof Demand>;

/** §6.5 */
export const Supply = z.object({
  id: zId,
  source_id: z.string(),
  external_ref: z.string().nullable(),
  counterparty_id: zId.nullable(),
  title: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  price: Money.nullable(),
  currency: z.string(),
  quantity: z.number().nullable(),
  condition_json: z.record(z.unknown()).default({}),
  location: GeoLocation.nullable(),
  geo_point: GeoPoint.nullable(),
  fulfillment_options_json: z.array(z.string()).default([]),
  availability_status: AvailabilityStatus,
  source_evidence_id: zId.nullable(),
  last_verified_at: zIso.nullable(),
  created_at: zIso,
});
export type Supply = z.infer<typeof Supply>;

/** §6.6 */
export const Match = z.object({
  id: zId,
  demand_id: zId,
  supply_id: zId,
  semantic_score: z.number().min(0).max(1),
  constraint_score: z.number().min(0).max(1),
  geography_score: z.number().min(0).max(1),
  timing_score: z.number().min(0).max(1),
  quality_score: z.number().min(0).max(1),
  total_match_score: z.number().min(0).max(1),
  explanation_json: z.record(z.unknown()).default({}),
  created_at: zIso,
});
export type Match = z.infer<typeof Match>;

/** §6.7 */
export const Opportunity = z.object({
  id: zId,
  match_id: zId,
  status: OpportunityStatus,
  transaction_role: z.enum(["buyer", "seller", "broker"]),
  expected_revenue: Money.nullable(),
  expected_direct_cost: Money.nullable(),
  expected_net_profit: Money.nullable(),
  capital_required: Money.nullable(),
  close_probability: z.number().min(0).max(1),
  time_to_cash_minutes: z.number().int().nonnegative().nullable(),
  repeatability_score: z.number().min(0).max(1),
  payment_certainty_score: z.number().min(0).max(1),
  fraud_risk_score: z.number().min(0).max(1),
  compliance_risk_score: z.number().min(0).max(1),
  operational_friction_score: z.number().min(0).max(1),
  customer_value_score: z.number().min(0).max(1),
  overall_score: z.number().min(0).max(1),
  score_version: z.string(),
  next_action: z.string().nullable(),
  last_verified_at: zIso.nullable(),
  expires_at: zIso.nullable(),
  created_at: zIso,
});
export type Opportunity = z.infer<typeof Opportunity>;

/** §6.8 — never merge identities from LLM inference alone (§13, §29). */
export const Counterparty = z.object({
  id: zId,
  type: CounterpartyType,
  normalized_name: z.string(),
  source_identities_json: z.array(z.record(z.unknown())).default([]),
  trust_score: z.number().min(0).max(1),
  verification_level: z.enum(["none", "weak", "deterministic", "human_reviewed"]),
  risk_flags_json: z.array(z.string()).default([]),
  transaction_stats_json: z.record(z.unknown()).default({}),
  created_at: zIso,
});
export type Counterparty = z.infer<typeof Counterparty>;

/** §6.9 — policy-enforced human gate record (§14). */
export const Approval = z.object({
  id: zId,
  requested_by_agent: z.string(),
  action_type: z.string(),
  entity_type: z.string(),
  entity_id: zId,
  payload_hash: zHash,
  human_readable_summary: z.string(),
  risk_summary: z.string().nullable(),
  expires_at: zIso,
  status: ApprovalStatus,
  decided_by: zId.nullable(),
  decision: ApprovalDecision.nullable(),
  decision_metadata_json: z.record(z.unknown()).default({}),
  decided_at: zIso.nullable(),
});
export type Approval = z.infer<typeof Approval>;

/** §6.10 */
export const Negotiation = z.object({
  id: zId,
  opportunity_id: zId,
  side: NegotiationSide,
  state: NegotiationState,
  approved_bounds_json: z.record(z.unknown()).default({}),
  draft_messages_json: z.array(z.record(z.unknown())).default([]),
  outbound_message_ids: z.array(z.string()).default([]),
  offers_json: z.array(z.record(z.unknown())).default([]),
  created_at: zIso,
});
export type Negotiation = z.infer<typeof Negotiation>;

/** §6.11 */
export const Transaction = z.object({
  id: zId,
  opportunity_id: zId,
  buyer_id: zId.nullable(),
  seller_id: zId.nullable(),
  status: TransactionStatus,
  terms_version: z.number().int().nonnegative(),
  terms_hash: zHash,
  gross_amount: Money,
  currency: z.string(),
  platform_revenue: Money.nullable(),
  settlement_plan_id: zId.nullable(),
  fulfillment_plan_id: zId.nullable(),
  created_at: zIso,
});
export type Transaction = z.infer<typeof Transaction>;

/** §6.12 */
export const SettlementPlan = z.object({
  id: zId,
  transaction_id: zId,
  rail_family: RailFamily,
  provider: z.string(),
  asset: z.string(),
  total_amount: Money,
  status: SettlementStatus,
  human_release_policy: z.enum(["always", "over_threshold", "never"]),
  created_at: zIso,
});
export type SettlementPlan = z.infer<typeof SettlementPlan>;

/** §6.13 */
export const SettlementMilestone = z.object({
  id: zId,
  settlement_plan_id: zId,
  sequence: z.number().int().nonnegative(),
  name: z.string(),
  amount_or_percentage: z.object({
    kind: z.enum(["amount", "percentage"]),
    value: z.number(),
  }),
  required_evidence_json: z.array(z.record(z.unknown())).default([]),
  release_conditions_json: z.record(z.unknown()).default({}),
  status: z.enum(["pending", "verified", "released", "disputed"]),
  approved_at: zIso.nullable(),
  released_at: zIso.nullable(),
  external_transaction_ref: z.string().nullable(),
});
export type SettlementMilestone = z.infer<typeof SettlementMilestone>;

/** §6.14 — captured provenance for every observation/decision. */
export const Evidence = z.object({
  id: zId,
  entity_type: z.string(),
  entity_id: zId,
  source: z.string(),
  source_uri: z.string().nullable(),
  content_hash: zHash,
  captured_at: zIso,
  expires_at: zIso.nullable(),
  metadata_json: z.record(z.unknown()).default({}),
});
export type Evidence = z.infer<typeof Evidence>;

/** §6.15 — append-only, hash-chained (§21). */
export const AuditEvent = z.object({
  id: zId,
  actor_type: ActorType,
  actor_id: z.string().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  input_hash: zHash.nullable(),
  output_hash: zHash.nullable(),
  policy_version: z.string().nullable(),
  model_provider: z.string().nullable(),
  model: z.string().nullable(),
  model_version: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  previous_event_hash: zHash.nullable(),
  event_hash: zHash,
  created_at: zIso,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
