-- Opportunity OS V1 — initial schema (§6 core domain model, §10 outbox, §21 audit).
-- Idempotent-ish DDL: safe to run once against a fresh database.

create extension if not exists "pgcrypto";

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  display_name  text not null,
  role          text not null check (role in ('user','operator','reviewer','admin','service','agent')),
  trust_tier    text not null default 'basic' check (trust_tier in ('untrusted','basic','verified','trusted')),
  status        text not null default 'active' check (status in ('active','suspended','pending')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table missions (
  id                     uuid primary key default gen_random_uuid(),
  owner_user_id          uuid not null references users(id),
  title                  text not null,
  raw_intent             text not null,
  status                 text not null default 'draft' check (status in ('draft','active','paused','archived','completed')),
  current_version_id     uuid,
  agent_autonomy_policy  text not null default 'discover_only',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  archived_at            timestamptz
);
create index missions_owner_idx on missions(owner_user_id);
create index missions_status_idx on missions(status);

create table mission_versions (
  id                uuid primary key default gen_random_uuid(),
  mission_id        uuid not null references missions(id),
  version_number    integer not null,
  demand_spec_json  jsonb not null,
  changed_by        uuid not null references users(id),
  change_reason     text not null,
  created_at        timestamptz not null default now(),
  unique (mission_id, version_number)
);
alter table missions
  add constraint missions_current_version_fk
  foreign key (current_version_id) references mission_versions(id);

create table counterparties (
  id                      uuid primary key default gen_random_uuid(),
  type                    text not null check (type in ('person','organization')),
  normalized_name         text not null,
  source_identities_json  jsonb not null default '[]',
  trust_score             double precision not null default 0,
  verification_level      text not null default 'none' check (verification_level in ('none','weak','deterministic','human_reviewed')),
  risk_flags_json         jsonb not null default '[]',
  transaction_stats_json  jsonb not null default '{}',
  created_at              timestamptz not null default now()
);

create table evidence (
  id            uuid primary key default gen_random_uuid(),
  entity_type   text not null,
  entity_id     uuid not null,
  source        text not null,
  source_uri    text,
  content_hash  text not null,
  captured_at   timestamptz not null default now(),
  expires_at    timestamptz,
  metadata_json jsonb not null default '{}'
);
create index evidence_entity_idx on evidence(entity_type, entity_id);

create table demands (
  id                          uuid primary key default gen_random_uuid(),
  mission_id                  uuid references missions(id),
  source_id                   text not null,
  external_ref                text,
  description                 text not null,
  category                    text,
  counterparty_id             uuid references counterparties(id),
  target_price                jsonb,
  max_budget                  jsonb,
  currency                    text not null default 'USD',
  quality_constraints_json    jsonb not null default '[]',
  needed_by                   timestamptz,
  urgency_score               double precision not null default 0,
  importance_context          text,
  payment_preferences_json    jsonb not null default '[]',
  fulfillment_location        jsonb,
  geo_point                   jsonb,
  acceptable_substitutes_json jsonb not null default '[]',
  non_negotiables_json        jsonb not null default '[]',
  negotiation_limits_json     jsonb not null default '{}',
  confidence                  double precision not null default 0,
  availability_status         text not null default 'unknown',
  last_verified_at            timestamptz,
  created_at                  timestamptz not null default now()
);
create index demands_mission_idx on demands(mission_id);
create index demands_category_idx on demands(category);

create table supply (
  id                        uuid primary key default gen_random_uuid(),
  source_id                 text not null,
  external_ref              text,
  counterparty_id           uuid references counterparties(id),
  title                     text not null,
  description               text not null,
  category                  text,
  price                     jsonb,
  currency                  text not null default 'USD',
  quantity                  double precision,
  condition_json            jsonb not null default '{}',
  location                  jsonb,
  geo_point                 jsonb,
  fulfillment_options_json  jsonb not null default '[]',
  availability_status       text not null default 'unknown',
  source_evidence_id        uuid references evidence(id),
  last_verified_at          timestamptz,
  created_at                timestamptz not null default now()
);
create index supply_category_idx on supply(category);

create table matches (
  id                uuid primary key default gen_random_uuid(),
  demand_id         uuid not null references demands(id),
  supply_id         uuid not null references supply(id),
  semantic_score    double precision not null default 0,
  constraint_score  double precision not null default 0,
  geography_score   double precision not null default 0,
  timing_score      double precision not null default 0,
  quality_score     double precision not null default 0,
  total_match_score double precision not null default 0,
  explanation_json  jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  unique (demand_id, supply_id)
);

create table opportunities (
  id                          uuid primary key default gen_random_uuid(),
  match_id                    uuid not null references matches(id),
  status                      text not null default 'candidate',
  transaction_role            text not null check (transaction_role in ('buyer','seller','broker')),
  expected_revenue            jsonb,
  expected_direct_cost        jsonb,
  expected_net_profit         jsonb,
  capital_required            jsonb,
  close_probability           double precision not null default 0,
  time_to_cash_minutes        integer,
  repeatability_score         double precision not null default 0,
  payment_certainty_score     double precision not null default 0,
  fraud_risk_score            double precision not null default 0,
  compliance_risk_score       double precision not null default 0,
  operational_friction_score  double precision not null default 0,
  customer_value_score        double precision not null default 0,
  overall_score               double precision not null default 0,
  score_version               text not null default 'v1',
  next_action                 text,
  last_verified_at            timestamptz,
  expires_at                  timestamptz,
  created_at                  timestamptz not null default now()
);
create index opportunities_status_score_idx on opportunities(status, overall_score desc);

create table approvals (
  id                     uuid primary key default gen_random_uuid(),
  requested_by_agent     text not null,
  action_type            text not null,
  entity_type            text not null,
  entity_id              uuid not null,
  payload_hash           text not null,
  human_readable_summary text not null,
  risk_summary           text,
  expires_at             timestamptz not null,
  status                 text not null default 'pending',
  decided_by             uuid references users(id),
  decision               text,
  decision_metadata_json jsonb not null default '{}',
  decided_at             timestamptz
);
create index approvals_status_idx on approvals(status);

create table negotiations (
  id                   uuid primary key default gen_random_uuid(),
  opportunity_id       uuid not null references opportunities(id),
  side                 text not null check (side in ('buy','sell')),
  state                text not null default 'draft',
  approved_bounds_json jsonb not null default '{}',
  draft_messages_json  jsonb not null default '[]',
  outbound_message_ids jsonb not null default '[]',
  offers_json          jsonb not null default '[]',
  created_at           timestamptz not null default now()
);

create table transactions (
  id                  uuid primary key default gen_random_uuid(),
  opportunity_id      uuid not null references opportunities(id),
  buyer_id            uuid references users(id),
  seller_id           uuid references users(id),
  status              text not null default 'proposed',
  terms_version       integer not null default 0,
  terms_hash          text not null,
  gross_amount        jsonb not null,
  currency            text not null default 'USD',
  platform_revenue    jsonb,
  settlement_plan_id  uuid,
  fulfillment_plan_id uuid,
  created_at          timestamptz not null default now()
);

create table settlement_plans (
  id                    uuid primary key default gen_random_uuid(),
  transaction_id        uuid not null references transactions(id),
  rail_family           text not null check (rail_family in ('fiat','stablecoin','onchain_programmable')),
  provider              text not null,
  asset                 text not null,
  total_amount          jsonb not null,
  status                text not null default 'DRAFT',
  human_release_policy  text not null default 'always' check (human_release_policy in ('always','over_threshold','never')),
  created_at            timestamptz not null default now()
);
alter table transactions
  add constraint transactions_settlement_plan_fk
  foreign key (settlement_plan_id) references settlement_plans(id);

create table settlement_milestones (
  id                       uuid primary key default gen_random_uuid(),
  settlement_plan_id       uuid not null references settlement_plans(id),
  sequence                 integer not null,
  name                     text not null,
  amount_or_percentage     jsonb not null,
  required_evidence_json   jsonb not null default '[]',
  release_conditions_json  jsonb not null default '{}',
  status                   text not null default 'pending' check (status in ('pending','verified','released','disputed')),
  approved_at              timestamptz,
  released_at              timestamptz,
  external_transaction_ref text,
  unique (settlement_plan_id, sequence)
);

-- §21 append-only, hash-chained audit log.
create table audit_events (
  id                   uuid primary key default gen_random_uuid(),
  actor_type           text not null check (actor_type in ('user','operator','agent','service','system')),
  actor_id             text,
  action               text not null,
  entity_type          text not null,
  entity_id            text not null,
  input_hash           text,
  output_hash          text,
  policy_version       text,
  model_provider       text,
  model                text,
  model_version        text,
  confidence           double precision,
  previous_event_hash  text,
  event_hash           text not null unique,
  created_at           timestamptz not null default now()
);
create index audit_events_entity_idx on audit_events(entity_type, entity_id);

-- Block UPDATE/DELETE on the audit log: append-only by policy (§21, §29).
create rule audit_events_no_update as on update to audit_events do instead nothing;
create rule audit_events_no_delete as on delete to audit_events do instead nothing;

-- §10/§550 transactional outbox.
create table outbox (
  id               uuid primary key default gen_random_uuid(),
  event_name       text not null,
  aggregate_type   text not null,
  aggregate_id     text not null,
  payload          jsonb not null,
  idempotency_key  text not null unique,
  published        boolean not null default false,
  created_at       timestamptz not null default now(),
  published_at     timestamptz
);
create index outbox_unpublished_idx on outbox(published, created_at) where published = false;
