import type { ColumnType, Generated } from "kysely";

/** DB timestamp: read as ISO string, optional on insert (DB default), string on update. */
type Timestamp = ColumnType<string, string | undefined, string>;
type Json = ColumnType<unknown, unknown, unknown>;
type JsonNullable = ColumnType<unknown, unknown, unknown> | null;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  role: string;
  trust_tier: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MissionsTable {
  id: Generated<string>;
  owner_user_id: string;
  title: string;
  raw_intent: string;
  status: string;
  current_version_id: string | null;
  agent_autonomy_policy: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface MissionVersionsTable {
  id: Generated<string>;
  mission_id: string;
  version_number: number;
  demand_spec_json: Json;
  changed_by: string;
  change_reason: string;
  created_at: Timestamp;
}

export interface DemandsTable {
  id: Generated<string>;
  mission_id: string | null;
  source_id: string;
  external_ref: string | null;
  description: string;
  category: string | null;
  counterparty_id: string | null;
  target_price: JsonNullable;
  max_budget: JsonNullable;
  currency: string;
  quality_constraints_json: Json;
  needed_by: Timestamp | null;
  urgency_score: number;
  importance_context: string | null;
  payment_preferences_json: Json;
  fulfillment_location: JsonNullable;
  geo_point: JsonNullable;
  acceptable_substitutes_json: Json;
  non_negotiables_json: Json;
  negotiation_limits_json: Json;
  confidence: number;
  availability_status: string;
  last_verified_at: Timestamp | null;
  created_at: Timestamp;
}

export interface SupplyTable {
  id: Generated<string>;
  source_id: string;
  external_ref: string | null;
  counterparty_id: string | null;
  title: string;
  description: string;
  category: string | null;
  price: JsonNullable;
  currency: string;
  quantity: number | null;
  condition_json: Json;
  location: JsonNullable;
  geo_point: JsonNullable;
  fulfillment_options_json: Json;
  availability_status: string;
  source_evidence_id: string | null;
  last_verified_at: Timestamp | null;
  created_at: Timestamp;
}

export interface MatchesTable {
  id: Generated<string>;
  demand_id: string;
  supply_id: string;
  semantic_score: number;
  constraint_score: number;
  geography_score: number;
  timing_score: number;
  quality_score: number;
  total_match_score: number;
  explanation_json: Json;
  created_at: Timestamp;
}

export interface OpportunitiesTable {
  id: Generated<string>;
  match_id: string;
  status: string;
  transaction_role: string;
  expected_revenue: JsonNullable;
  expected_direct_cost: JsonNullable;
  expected_net_profit: JsonNullable;
  capital_required: JsonNullable;
  close_probability: number;
  time_to_cash_minutes: number | null;
  repeatability_score: number;
  payment_certainty_score: number;
  fraud_risk_score: number;
  compliance_risk_score: number;
  operational_friction_score: number;
  customer_value_score: number;
  overall_score: number;
  score_version: string;
  next_action: string | null;
  last_verified_at: Timestamp | null;
  expires_at: Timestamp | null;
  created_at: Timestamp;
}

export interface CounterpartiesTable {
  id: Generated<string>;
  type: string;
  normalized_name: string;
  source_identities_json: Json;
  trust_score: number;
  verification_level: string;
  risk_flags_json: Json;
  transaction_stats_json: Json;
  created_at: Timestamp;
}

export interface ApprovalsTable {
  id: Generated<string>;
  requested_by_agent: string;
  action_type: string;
  entity_type: string;
  entity_id: string;
  payload_hash: string;
  human_readable_summary: string;
  risk_summary: string | null;
  expires_at: Timestamp;
  status: string;
  decided_by: string | null;
  decision: string | null;
  decision_metadata_json: Json;
  decided_at: Timestamp | null;
  notified_at: Timestamp | null;
}

export interface NegotiationsTable {
  id: Generated<string>;
  opportunity_id: string;
  side: string;
  state: string;
  approved_bounds_json: Json;
  draft_messages_json: Json;
  outbound_message_ids: Json;
  offers_json: Json;
  created_at: Timestamp;
}

export interface TransactionsTable {
  id: Generated<string>;
  opportunity_id: string;
  buyer_id: string | null;
  seller_id: string | null;
  status: string;
  terms_version: number;
  terms_hash: string;
  gross_amount: Json;
  currency: string;
  platform_revenue: JsonNullable;
  settlement_plan_id: string | null;
  fulfillment_plan_id: string | null;
  created_at: Timestamp;
}

export interface SettlementPlansTable {
  id: Generated<string>;
  transaction_id: string;
  rail_family: string;
  provider: string;
  asset: string;
  total_amount: Json;
  status: string;
  human_release_policy: string;
  created_at: Timestamp;
}

export interface SettlementMilestonesTable {
  id: Generated<string>;
  settlement_plan_id: string;
  sequence: number;
  name: string;
  amount_or_percentage: Json;
  required_evidence_json: Json;
  release_conditions_json: Json;
  status: string;
  approved_at: Timestamp | null;
  released_at: Timestamp | null;
  external_transaction_ref: string | null;
}

export interface EvidenceTable {
  id: Generated<string>;
  entity_type: string;
  entity_id: string;
  source: string;
  source_uri: string | null;
  content_hash: string;
  captured_at: Timestamp;
  expires_at: Timestamp | null;
  metadata_json: Json;
}

export interface AuditEventsTable {
  id: Generated<string>;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  input_hash: string | null;
  output_hash: string | null;
  policy_version: string | null;
  model_provider: string | null;
  model: string | null;
  model_version: string | null;
  confidence: number | null;
  previous_event_hash: string | null;
  event_hash: string;
  created_at: Timestamp;
}

/** §10, §550 — transactional outbox so DB writes and event publication cannot diverge. */
export interface OutboxTable {
  id: Generated<string>;
  event_name: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Json;
  idempotency_key: string;
  published: Generated<boolean>;
  created_at: Timestamp;
  published_at: Timestamp | null;
}

export interface SignalsTable {
  id: Generated<string>;
  channel: string;
  kind: string;
  source_id: string;
  external_ref: string | null;
  title: string | null;
  description: string;
  category: string | null;
  price: JsonNullable;
  geo_point: JsonNullable;
  raw_json: Json;
  content_hash: string;
  source_reliability: number;
  status: string;
  resolved_entity_type: string | null;
  resolved_entity_id: string | null;
  captured_at: Timestamp;
  created_at: Timestamp;
}

export interface OutcomesTable {
  id: Generated<string>;
  opportunity_id: string | null;
  transaction_id: string | null;
  status: string;
  realized_amount: JsonNullable;
  realized_profit: JsonNullable;
  days_to_close: number | null;
  shipping_cost: JsonNullable;
  notes: string | null;
  metadata_json: Json;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  missions: MissionsTable;
  mission_versions: MissionVersionsTable;
  demands: DemandsTable;
  supply: SupplyTable;
  matches: MatchesTable;
  opportunities: OpportunitiesTable;
  counterparties: CounterpartiesTable;
  approvals: ApprovalsTable;
  negotiations: NegotiationsTable;
  transactions: TransactionsTable;
  settlement_plans: SettlementPlansTable;
  settlement_milestones: SettlementMilestonesTable;
  evidence: EvidenceTable;
  audit_events: AuditEventsTable;
  outbox: OutboxTable;
  signals: SignalsTable;
  outcomes: OutcomesTable;
}
