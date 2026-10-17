import type { ColumnType, Generated } from "kysely";

/** DB timestamp: read as ISO string, optional on insert (DB default), string on update. */
type Timestamp = ColumnType<string, string | undefined, string>;
type Json = ColumnType<unknown, unknown, unknown>;
type JsonNullable = ColumnType<unknown, unknown, unknown> | null;
/** A jsonb column with a database default: optional on insert. */
type JsonDefault = ColumnType<unknown, unknown | undefined, unknown>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  role: string;
  trust_tier: Generated<string>;
  status: Generated<string>;
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
  temporal_workflow_id: string | null;
}

export interface MissionSharesTable {
  id: Generated<string>;
  mission_id: string;
  user_id: string;
  role: string;
  granted_by: string;
  created_at: Generated<Timestamp>;
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
  /** The listing's page at its source (0023). */
  listing_url: Generated<string | null>;
  /** Who is selling, as the source names them: `{ name, url?, detail? }` (0023). */
  seller_json: Json;
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
  match_id: string | null;
  kind: Generated<string>;
  dedupe_key: string | null;
  source_json: JsonNullable;
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
  rejection_reason: Generated<string | null>;
  rejected_by: Generated<string | null>;
  rejected_at: ColumnType<string | null, string | null | undefined, string | null>;
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
  // 0030: relationships (ADR-041).
  display_name: string | null;
  organization_id: string | null;
  role_title: string | null;
  website: string | null;
  location: string | null;
  source_type: string | null;
  source_url: string | null;
  status: Generated<string>;
  last_activity_at: Timestamp;
  archived_at: Timestamp | null;
  freshness_checked_at: Timestamp | null;
  freshness_due_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface ContactChannelsTable {
  id: Generated<string>;
  counterparty_id: string;
  kind: string;
  value: string;
  normalized_value: string;
  label: string | null;
  is_primary: Generated<boolean>;
  status: Generated<string>;
  source_label: Generated<string>;
  source_url: string | null;
  verified_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface ContactConsentsTable {
  id: Generated<string>;
  counterparty_id: string;
  channel_kind: string;
  purpose: string;
  status: string;
  basis: string;
  evidence: string | null;
  recorded_by: string | null;
  recorded_at: Generated<Timestamp>;
  expires_at: Timestamp | null;
}

export interface ConversationsTable {
  id: Generated<string>;
  counterparty_id: string;
  channel: Generated<string>;
  their_address: string;
  subject: string;
  subject_type: string | null;
  subject_id: string | null;
  status: Generated<string>;
  last_outbound_at: Timestamp | null;
  last_inbound_at: Timestamp | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

export interface ConversationMessagesTable {
  id: Generated<string>;
  conversation_id: string;
  direction: string;
  status: string;
  subject: string;
  body_text: string;
  content_hash: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  to_address: string | null;
  classification: string | null;
  injection_flag: Generated<boolean>;
  approved_by: string | null;
  approved_at: Timestamp | null;
  queued_at: Timestamp | null;
  sent_at: Timestamp | null;
  received_at: Timestamp | null;
  reviewed_at: Timestamp | null;
  reviewed_by: string | null;
  error: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface OutreachMailboxStateTable {
  mailbox: string;
  uid_validity: string | number;
  last_uid: string | number;
  polled_at: Timestamp;
}

export interface ContactSuppressionsTable {
  identifier_hash: string;
  kind: string;
  reason: string;
  created_at: Generated<Timestamp>;
}

export interface RelationshipMemoriesTable {
  id: Generated<string>;
  counterparty_id: string;
  kind: string;
  content: string;
  source_type: string;
  source_ref: string | null;
  source_label: string;
  confidence: Numeric;
  access: Generated<string>;
  observed_at: Timestamp | null;
  expires_at: Timestamp | null;
  status: Generated<string>;
  superseded_by: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
}

export interface CounterpartyLinksTable {
  id: Generated<string>;
  counterparty_id: string;
  subject_type: string;
  subject_id: string;
  role: string;
  created_at: Generated<Timestamp>;
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
  provider_ref: string | null;
  disputed_at: Timestamp | null;
  frozen_at: Timestamp | null;
  refunded_at: Timestamp | null;
  pre_dispute_status: string | null;
  pre_freeze_status: string | null;
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
  disputed_at: Timestamp | null;
  refunded_at: Timestamp | null;
  external_refund_ref: string | null;
  pre_dispute_status: string | null;
  optimistic_after_at: Timestamp | null;
  deadman_at: Timestamp | null;
  recipients_json: Json;
  provider_ref: string | null;
}

export interface AssetTransferPlansTable {
  id: Generated<string>;
  transaction_id: string;
  provider: string;
  asset_kind: string;
  asset_json: Json;
  to_address: string;
  reference: string | null;
  external_ref: string | null;
  status: string;
  created_at: Timestamp;
  executed_at: Timestamp | null;
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
  verifier: string | null;
  trust_tier: string | null;
  predicate_type: string | null;
  satisfies_json: Json;
  previous_evidence_hash: string | null;
  evidence_hash: string | null;
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

export interface EntitiesTable {
  id: Generated<string>;
  kind: string;
  category: string | null;
  canonical_key: string;
  title: string;
  attributes_json: Json;
  embedding: JsonNullable;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EntityMembersTable {
  id: Generated<string>;
  entity_id: string;
  member_type: string;
  member_id: string;
  created_at: Timestamp;
}

export interface PriceObservationsTable {
  id: Generated<string>;
  entity_id: string;
  member_type: string;
  member_id: string;
  amount_minor: number;
  currency: string;
  observed_at: Timestamp;
}

export interface GraphEdgesTable {
  id: Generated<string>;
  src_type: string;
  src_id: string;
  dst_type: string;
  dst_id: string;
  relation: string;
  weight: number;
  metadata_json: Json;
  created_at: Timestamp;
}

/** Postgres numeric: node-pg returns a string to keep precision. */
type Numeric = ColumnType<string, number | string | undefined, number | string>;

export interface IntelRunsTable {
  id: Generated<string>;
  started_at: Timestamp;
  finished_at: string | null;
  status: Generated<string>;
  search_calls: Generated<number>;
  llm_calls: Generated<number>;
  search_usd: Numeric;
  llm_usd: Numeric;
  leads_found: Generated<number>;
  candidates: Generated<number>;
  notes: Json;
  lane: Generated<string>;
}

export interface IntelSourcesTable {
  id: Generated<string>;
  hostname: string;
  source_type: string | null;
  orientation: string | null;
  leads: Generated<number>;
  actionable: Generated<number>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
}

export interface IntelLeadsTable {
  id: Generated<string>;
  run_id: string | null;
  kind: string;
  title: string;
  summary: string;
  url: string;
  url_hash: string;
  hostname: string;
  query: string;
  search_provider: string;
  discovered_at: Timestamp;
  published_at: string | null;
  age_text: string | null;
  item: string | null;
  category: string | null;
  quantity: string | null;
  location: string | null;
  deadline: string | null;
  price_minor: number | null;
  currency: string | null;
  urgency: string | null;
  credibility: Numeric;
  contact: Json;
  facts: Json;
  opposite_queries: Json;
  status: Generated<string>;
  signal_type: string | null;
  evidence_level: Generated<string>;
  supply_terms: JsonDefault;
  title_unverified: Generated<boolean>;
  last_seen_at: Generated<Timestamp>;
  seen_count: Generated<number>;
  counterpart_status: Generated<string>;
  counterpart_attempts: Generated<number>;
  counterpart_next_at: Timestamp | null;
  counterparts: JsonDefault;
}

/** Migration 0027: what a lead or candidate rests on, as captured (PRD v2 FR-04). */
export interface OpportunityEvidenceTable {
  id: Generated<string>;
  subject_type: string;
  subject_id: string;
  kind: string;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  label: string;
  observed_at: Timestamp | null;
  captured_at: Generated<Timestamp>;
  content_hash: string;
}

/** Migration 0027: every economics calculation, append-only (PRD v2 FR-04). */
export interface OpportunityEconomicsVersionsTable {
  id: Generated<string>;
  subject_type: string;
  subject_id: string;
  version: number;
  model_version: string;
  mode: string;
  inputs: Json;
  outputs: Json;
  net_low_usd: Numeric;
  net_high_usd: Numeric;
  expected_mid_usd: Numeric;
  tier: string;
  gates: JsonDefault;
  created_at: Generated<Timestamp>;
}

/** Migration 0029: a subject elevated to a CRM (ADR-040). */
export interface CrmLinksTable {
  id: Generated<string>;
  provider: string;
  subject_type: string;
  subject_id: string;
  external_id: string | null;
  external_url: string | null;
  external_status: Generated<string>;
  external_stage_id: number | null;
  value: Numeric | null;
  currency: string | null;
  lost_reason: string | null;
  last_event_id: string | null;
  last_event_at: Timestamp | null;
  elevated_by: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface CrmWebhookEventsTable {
  provider: string;
  event_id: string;
  link_id: string | null;
  action: string;
  entity_id: string | null;
  received_at: Generated<Timestamp>;
}

/** Migration 0026: inferred demand on a watchlist (PRD v2 FR-03). */
export interface DemandHypothesesTable {
  id: Generated<string>;
  run_id: string | null;
  signal_type: string;
  hypothesis: string;
  basis: string;
  evidence: JsonDefault;
  source_url: string;
  source_url_hash: string;
  hostname: string;
  query: string;
  item: string | null;
  location: string | null;
  confidence: Numeric;
  check_query: string | null;
  status: Generated<string>;
  status_reason: string | null;
  revisit_days: Generated<number>;
  revisit_at: Timestamp;
  expires_at: Timestamp;
  revisit_count: Generated<number>;
  checks: JsonDefault;
  confirmed_lead_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface IntelCandidatesTable {
  id: Generated<string>;
  run_id: string | null;
  lead_id: string;
  counter_url: string | null;
  counter_summary: string | null;
  service_key: string | null;
  match_kind: string;
  title: string;
  match_rationale: string;
  verification_status: string;
  freshness: Numeric;
  economics: Json;
  monetization: Json;
  regulatory_flags: Json;
  fraud_flags: Json;
  contact: Json;
  ev_low_usd: Numeric;
  ev_high_usd: Numeric;
  confidence: string;
  score: Numeric;
  explanation: Json;
  outreach: Json;
  bucket: string;
  reject_reason: string | null;
  user_status: Generated<string>;
  outcome_reason: string | null;
  outcome_note: string | null;
  realized_usd: Numeric | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Migration 0025 (renamed from intel_query_sources): every place discovery reads from. */
export interface SourceRegistryTable {
  id: Generated<string>;
  kind: Generated<string>;
  external_id: string | null;
  name: string;
  domain: string;
  orientation: string;
  topics: Json;
  sector: string | null;
  geography: string | null;
  signal_type: string | null;
  access_method: string | null;
  notes: string | null;
  priority: string | null;
  evidence_url: string | null;
  status: string;
  status_reason: string | null;
  origin: Generated<string>;
  url: string | null;
  markets: JsonDefault;
  api_available: Generated<boolean>;
  apify_actor_id: string | null;
  apify_actor_version: string | null;
  // 0031: Apify run configuration (ADR-042).
  apify_input: JsonNullable;
  apify_field_map: JsonNullable;
  apify_expected_fields: JsonNullable;
  apify_max_items: number | null;
  apify_max_charge_usd: Numeric | null;
  apify_search: JsonNullable;
  permission_basis: Generated<string>;
  robots_tos_assessment: string | null;
  data_use_constraints: string | null;
  terms_reviewed_at: Timestamp | null;
  terms_review_due_at: Timestamp | null;
  contact_path: string | null;
  min_interval_minutes: number | null;
  cost_per_run_usd: Numeric | null;
  max_daily_usd: Numeric | null;
  health: Generated<string>;
  consecutive_failures: Generated<number>;
  last_run_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SourcePolicyReviewsTable {
  id: Generated<string>;
  source_id: string;
  decision: string;
  permission_basis: string;
  robots_tos_assessment: string | null;
  data_use_constraints: string | null;
  terms_review_due_at: Timestamp | null;
  notes: string | null;
  reviewed_by: string | null;
  reviewer_label: string | null;
  created_at: Generated<Timestamp>;
}

export interface ApifyRunsTable {
  id: Generated<string>;
  source_id: string;
  apify_run_id: string;
  dataset_id: string | null;
  status: Generated<string>;
  apify_status: string | null;
  max_charge_usd: Numeric | null;
  usage_usd: Numeric | null;
  items_total: Generated<number>;
  items_new: Generated<number>;
  items_changed: Generated<number>;
  items_duplicate: Generated<number>;
  items_merged: Generated<number>;
  items_quarantined: Generated<number>;
  error: string | null;
  retry_after: Timestamp | null;
  started_at: Generated<Timestamp>;
  finished_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface ApifyRunSearchesTable {
  id: Generated<string>;
  apify_run_id: string;
  source_id: string;
  term: string;
  city: string | null;
  url: string;
  origin: string;
  items: Generated<number>;
  items_new: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface DealChecksTable {
  id: Generated<string>;
  observation_id: string;
  source_id: string;
  supply_id: string | null;
  query: string | null;
  price_minor: ColumnType<string | null, number | null, number | null>;
  currency: string | null;
  comps: Generated<number>;
  comp_median_minor: ColumnType<string | null, number | null, number | null>;
  discount: Numeric | null;
  demand_term: string | null;
  verdict: string;
  comps_json: JsonDefault;
  lead_id: string | null;
  checked_at: Generated<Timestamp>;
}

export interface SourceObservationsTable {
  id: Generated<string>;
  source_id: string;
  apify_run_id: string | null;
  kind: string;
  external_id: string;
  canonical_key: string | null;
  content_hash: string;
  content: Json;
  supply_id: string | null;
  merged: Generated<boolean>;
  lead_id: string | null;
  lead_checked_at: Timestamp | null;
  first_seen_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
  seen_count: Generated<number>;
}

export interface IngestionQuarantineTable {
  id: Generated<string>;
  source_id: string;
  apify_run_id: string | null;
  external_id: string | null;
  reason: string;
  fields: JsonDefault;
  item: Json;
  status: Generated<string>;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface SourceRunsTable {
  id: Generated<string>;
  source_id: string | null;
  intel_run_id: string | null;
  query: string;
  results: Generated<number>;
  new_results: Generated<number>;
  leads: Generated<number>;
  cost_usd: Numeric;
  error: string | null;
  created_at: Generated<Timestamp>;
}

export interface OffnetworkMatchesTable {
  id: Generated<string>;
  listing_origin: string;
  listing_side: string;
  listing_ref: string;
  listing_title: string;
  counterparty_name: string;
  counterparty_contact: string | null;
  terms: string | null;
  price_minor: number | null;
  currency: string | null;
  status: Generated<string>;
  outcome_note: string | null;
  created_by: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface Database {
  users: UsersTable;
  missions: MissionsTable;
  mission_versions: MissionVersionsTable;
  mission_shares: MissionSharesTable;
  demands: DemandsTable;
  supply: SupplyTable;
  matches: MatchesTable;
  opportunities: OpportunitiesTable;
  counterparties: CounterpartiesTable;
  contact_channels: ContactChannelsTable;
  contact_consents: ContactConsentsTable;
  contact_suppressions: ContactSuppressionsTable;
  relationship_memories: RelationshipMemoriesTable;
  counterparty_links: CounterpartyLinksTable;
  conversations: ConversationsTable;
  conversation_messages: ConversationMessagesTable;
  outreach_mailbox_state: OutreachMailboxStateTable;
  approvals: ApprovalsTable;
  negotiations: NegotiationsTable;
  transactions: TransactionsTable;
  settlement_plans: SettlementPlansTable;
  settlement_milestones: SettlementMilestonesTable;
  asset_transfer_plans: AssetTransferPlansTable;
  evidence: EvidenceTable;
  audit_events: AuditEventsTable;
  outbox: OutboxTable;
  signals: SignalsTable;
  outcomes: OutcomesTable;
  entities: EntitiesTable;
  entity_members: EntityMembersTable;
  price_observations: PriceObservationsTable;
  graph_edges: GraphEdgesTable;
  intel_runs: IntelRunsTable;
  intel_sources: IntelSourcesTable;
  intel_leads: IntelLeadsTable;
  intel_candidates: IntelCandidatesTable;
  offnetwork_matches: OffnetworkMatchesTable;
  source_registry: SourceRegistryTable;
  demand_hypotheses: DemandHypothesesTable;
  opportunity_evidence: OpportunityEvidenceTable;
  crm_links: CrmLinksTable;
  crm_webhook_events: CrmWebhookEventsTable;
  opportunity_economics_versions: OpportunityEconomicsVersionsTable;
  source_policy_reviews: SourcePolicyReviewsTable;
  source_runs: SourceRunsTable;
  apify_runs: ApifyRunsTable;
  apify_run_searches: ApifyRunSearchesTable;
  deal_checks: DealChecksTable;
  source_observations: SourceObservationsTable;
  ingestion_quarantine: IngestionQuarantineTable;
}
