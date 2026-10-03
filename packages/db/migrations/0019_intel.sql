-- AIOOS opportunity intelligence (docs/Opportunity_OS_AIOOS_Master_Prompt.md):
-- internet signal -> lead -> matched candidate -> human action queue, with a
-- search/LLM spend ledger and a source registry. Kept beside the mission-driven
-- opportunities model rather than overloading it.

-- One scheduled sweep; the spend ledger (AIOOS §22). The daily cap is enforced
-- against the sum of today's rows.
create table if not exists intel_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'completed', 'budget_exhausted', 'failed')),
  search_calls  integer not null default 0,
  llm_calls     integer not null default 0,
  search_usd    numeric(12, 6) not null default 0,
  llm_usd       numeric(12, 6) not null default 0,
  leads_found   integer not null default 0,
  candidates    integer not null default 0,
  notes         jsonb not null default '{}'::jsonb
);
create index if not exists intel_runs_started_idx on intel_runs(started_at desc);

-- Source registry (AIOOS §3): every host a lead came from is registered
-- automatically; yield = actionable / leads.
create table if not exists intel_sources (
  id             uuid primary key default gen_random_uuid(),
  hostname       text not null unique,
  source_type    text,
  orientation    text check (orientation in ('demand', 'supply', 'problem', 'mixed')),
  leads          integer not null default 0,
  actionable     integer not null default 0,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- A detected signal from one source page (AIOOS §5/§6/§8). Every extracted
-- field is labelled source fact / inference / unknown (AIOOS §29).
create table if not exists intel_leads (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references intel_runs(id) on delete set null,
  kind           text not null check (kind in ('demand', 'supply', 'problem')),
  title          text not null,
  summary        text not null,
  url            text not null,
  url_hash       text not null unique,
  hostname       text not null,
  query          text not null,
  search_provider text not null,
  discovered_at  timestamptz not null default now(),
  published_at   timestamptz,
  age_text       text,
  item           text,
  category       text,
  quantity       text,
  location       text,
  deadline       text,
  price_minor    integer,
  currency       text,
  urgency        text check (urgency in ('low', 'medium', 'high')),
  credibility    numeric(4, 3) not null default 0,
  contact        jsonb not null default 'null'::jsonb,
  facts          jsonb not null default '[]'::jsonb,
  opposite_queries jsonb not null default '[]'::jsonb,
  status         text not null default 'new' check (status in ('new', 'assessed', 'skipped'))
);
create index if not exists intel_leads_discovered_idx on intel_leads(discovered_at desc);

-- A lead matched to an opposite side (another lead, a search result, or one
-- of the user's own services), with verification, economics and the
-- "why do we get paid?" test (AIOOS §9, §12-§19, §26).
create table if not exists intel_candidates (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid references intel_runs(id) on delete set null,
  lead_id             uuid not null references intel_leads(id) on delete cascade,
  counter_url         text,
  counter_summary     text,
  service_key         text,
  match_kind          text not null check (match_kind in ('demand_to_supply', 'supply_to_demand', 'problem_to_service')),
  title               text not null,
  match_rationale     text not null,
  verification_status text not null check (verification_status in ('verified', 'strongly_supported', 'plausible', 'speculative', 'rejected')),
  freshness           numeric(4, 3) not null,
  economics           jsonb not null default '{}'::jsonb,
  monetization        jsonb not null default '{}'::jsonb,
  regulatory_flags    jsonb not null default '[]'::jsonb,
  fraud_flags         jsonb not null default '[]'::jsonb,
  contact             jsonb not null default 'null'::jsonb,
  ev_low_usd          numeric(12, 2) not null default 0,
  ev_high_usd         numeric(12, 2) not null default 0,
  confidence          text not null check (confidence in ('low', 'medium', 'high')),
  score               numeric(6, 2) not null default 0,
  explanation         jsonb not null default '{}'::jsonb,
  outreach            jsonb not null default '{}'::jsonb,
  bucket              text not null check (bucket in ('act_now', 'verify_next', 'watch', 'rejected')),
  reject_reason       text,
  user_status         text not null default 'open' check (user_status in ('open', 'contacted', 'responded', 'won', 'lost', 'dismissed')),
  outcome_reason      text,
  realized_usd        numeric(12, 2),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (lead_id, match_kind)
);
create index if not exists intel_candidates_bucket_idx on intel_candidates(bucket, score desc);
