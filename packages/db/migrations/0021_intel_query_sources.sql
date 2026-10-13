-- Searchable sources for the AIOOS sweep, added at runtime (an external agent
-- submits its findings) instead of only living in code. Each active row
-- contributes `site:<domain> <topic>` queries to stage-1 discovery, next to
-- the built-in venue list in packages/intel/src/queries.ts.
--
-- Distinct from intel_sources, which is the yield registry of hosts that leads
-- actually came from.
create table if not exists intel_query_sources (
  id             uuid primary key default gen_random_uuid(),
  -- The submitter's own id for the source (e.g. "SRC-012"), if it has one.
  external_id    text,
  name           text not null,
  domain         text not null,
  orientation    text not null check (orientation in ('demand', 'supply', 'problem')),
  topics         jsonb not null default '[]'::jsonb,
  sector         text,
  geography      text,
  signal_type    text,
  access_method  text,
  notes          text,
  priority       text,
  evidence_url   text,
  -- active: searched. paused: kept but not searched (reason says why; a person
  -- can resume it). rejected: unusable as submitted.
  status         text not null check (status in ('active', 'paused', 'rejected')),
  status_reason  text,
  origin         text not null default 'agent',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (domain, orientation)
);
create index if not exists intel_query_sources_status_idx on intel_query_sources(status);

-- Rows here become paid search queries. Row level security with no policy
-- keeps Supabase's anon and authenticated roles from reading or writing them;
-- the API and workers connect as the table owner.
alter table intel_query_sources enable row level security;
