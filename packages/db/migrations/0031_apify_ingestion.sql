-- Apify ingestion (PRD v2 FR-01, P1 slice 4; ADR-042).
--
-- An Apify actor is a source_registry row of kind 'apify_actor' with its run
-- configuration: the pinned actor and build (0025), the input, how dataset
-- fields map to an observation, the fields it is expected to return, and per
-- run limits. It runs only when the permission policy holds (ADR-037).
-- Each actor run is an apify_runs row; every item ingested from any source is
-- a source_observations row (provenance, duplicate avoidance, merging the
-- same listing seen through two sources); items that do not match what the
-- source is expected to return wait in ingestion_quarantine for a person.

alter table source_registry
  add column if not exists apify_input jsonb,
  add column if not exists apify_field_map jsonb,
  add column if not exists apify_expected_fields jsonb,
  add column if not exists apify_max_items integer,
  add column if not exists apify_max_charge_usd numeric(10, 4);

create table if not exists apify_runs (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references source_registry(id) on delete cascade,
  apify_run_id     text not null unique,
  dataset_id       text,
  -- running: started at Apify; ingesting: claimed by one process; then succeeded or failed.
  status           text not null default 'running' check (status in ('running', 'ingesting', 'succeeded', 'failed')),
  apify_status     text,
  max_charge_usd   numeric(10, 4),
  usage_usd        numeric(10, 4),
  items_total      integer not null default 0,
  items_new        integer not null default 0,
  items_changed    integer not null default 0,
  items_duplicate  integer not null default 0,
  items_merged     integer not null default 0,
  items_quarantined integer not null default 0,
  error            text,
  -- A failed run delays the source's next run (exponential backoff).
  retry_after      timestamptz,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists apify_runs_source_idx on apify_runs(source_id, started_at desc);
create index if not exists apify_runs_open_idx on apify_runs(status) where status in ('running', 'ingesting');
alter table apify_runs enable row level security;

create table if not exists source_observations (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references source_registry(id) on delete cascade,
  apify_run_id     uuid references apify_runs(id) on delete set null,
  kind             text not null check (kind in ('supply', 'demand')),
  external_id      text not null,
  -- The listing's identity across sources (normalized URL), for merging.
  canonical_key    text,
  content_hash     text not null,
  content          jsonb not null,
  supply_id        uuid references supply(id) on delete set null,
  -- Set when this observation was merged into a listing first seen through another source.
  merged           boolean not null default false,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  seen_count       integer not null default 1,
  unique (source_id, external_id)
);
create index if not exists source_observations_canonical_idx on source_observations(canonical_key) where canonical_key is not null;
create index if not exists source_observations_supply_idx on source_observations(supply_id) where supply_id is not null;
alter table source_observations enable row level security;

create table if not exists ingestion_quarantine (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references source_registry(id) on delete cascade,
  apify_run_id     uuid references apify_runs(id) on delete set null,
  external_id      text,
  reason           text not null check (reason in ('unexpected_fields', 'missing_required', 'invalid_value', 'category_unmapped', 'prompt_injection')),
  -- The fields behind the reason (the unexpected or missing ones).
  fields           jsonb not null default '[]',
  item             jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'released', 'discarded')),
  resolved_by      uuid,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists ingestion_quarantine_pending_idx on ingestion_quarantine(status, created_at desc);
alter table ingestion_quarantine enable row level security;
