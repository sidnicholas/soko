-- Independent supply and demand intelligence (PRD v2 FR-02, FR-03; P1 slice 2; ADR-038).
--
-- Leads stay the canonical record of an observed signal (no parallel signal
-- table): they gain the supply and demand fields FR-02/FR-03 ask for, whether
-- they were observed or inferred, when they were last seen, and the state of
-- the targeted search for the other side. Inferred demand (a precursor such as
-- hiring or a new project) is not a lead at all: it is a hypothesis on a
-- watchlist, revisited and expired by rule, and never shown as a buyer.

-- The registry code (0025) is deployed; nothing reads the old name any more.
drop view if exists intel_query_sources;

alter table intel_leads
  -- FR-02 / FR-03 signal taxonomy (packages/intel prompts.ts SIGNAL_TYPES).
  add column if not exists signal_type text,
  -- observed: the party states it (a listing, an RFQ). inferred: deduced (surplus implied by a closure).
  add column if not exists evidence_level text not null default 'observed',
  -- Supply terms as stated: moq, price_breaks, condition, shipping_terms, expiry, capacity.
  add column if not exists supply_terms jsonb not null default '{}'::jsonb,
  -- Liquidation and distressed stock: clear title is not assumed (FR-02).
  add column if not exists title_unverified boolean not null default false,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists seen_count integer not null default 1,
  -- Targeted search for the other side: suppliers for demand, buyers for supply.
  add column if not exists counterpart_status text not null default 'pending',
  add column if not exists counterpart_attempts integer not null default 0,
  add column if not exists counterpart_next_at timestamptz,
  add column if not exists counterparts jsonb not null default '[]'::jsonb;

alter table intel_leads drop constraint if exists intel_leads_evidence_level_check;
alter table intel_leads add constraint intel_leads_evidence_level_check check (evidence_level in ('observed', 'inferred'));
alter table intel_leads drop constraint if exists intel_leads_counterpart_status_check;
alter table intel_leads add constraint intel_leads_counterpart_status_check check (counterpart_status in ('pending', 'found', 'none_found', 'not_needed'));

-- Leads already assessed or retired need no counterpart search.
update intel_leads set counterpart_status = 'not_needed' where status <> 'new' and counterpart_status = 'pending';
update intel_leads set last_seen_at = discovered_at where last_seen_at > discovered_at and seen_count = 1;

create index if not exists intel_leads_counterpart_idx on intel_leads(counterpart_status, counterpart_next_at) where status = 'new';
create index if not exists intel_leads_kind_idx on intel_leads(kind, discovered_at desc);

-- Which lane a run served: demand (demand + problem leads) or supply.
alter table intel_runs add column if not exists lane text not null default 'all';
alter table intel_runs drop constraint if exists intel_runs_lane_check;
alter table intel_runs add constraint intel_runs_lane_check check (lane in ('all', 'demand', 'supply'));

-- Watchlist of inferred demand (FR-03): a precursor that may become a buyer.
create table if not exists demand_hypotheses (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid references intel_runs(id) on delete set null,
  signal_type        text not null,
  hypothesis         text not null,
  -- What was observed, with its source (label source_fact) and what was inferred from it.
  basis              text not null,
  evidence           jsonb not null default '[]'::jsonb,
  source_url         text not null,
  source_url_hash    text not null unique,
  hostname           text not null,
  query              text not null,
  item               text,
  location           text,
  confidence         numeric(4, 3) not null default 0,
  -- The search that would show the demand becoming explicit.
  check_query        text,
  status             text not null default 'watching' check (status in ('watching', 'confirmed', 'expired', 'dismissed')),
  status_reason      text,
  revisit_days       integer not null default 14,
  revisit_at         timestamptz not null,
  expires_at         timestamptz not null,
  revisit_count      integer not null default 0,
  -- Every revisit: when, what was searched, what came of it.
  checks             jsonb not null default '[]'::jsonb,
  confirmed_lead_id  uuid references intel_leads(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists demand_hypotheses_revisit_idx on demand_hypotheses(status, revisit_at);
alter table demand_hypotheses enable row level security;
