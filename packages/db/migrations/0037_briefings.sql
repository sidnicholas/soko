-- Daily brief (PRD v2 P2 "operator client brief, daily digest"; ADR-046).
--
-- One brief per local day: what changed in the last 24 hours (actionable
-- candidates, outreach, good deals, sources, spend), every line carrying
-- links to its source. Built by worker-lifecycle after the configured hour
-- and emailed to the operator when an address is set; regenerating replaces
-- the content of the same day.

create table if not exists briefings (
  id               uuid primary key default gen_random_uuid(),
  brief_date       date not null unique,
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  headline         text not null,
  content          jsonb not null,
  generated_at     timestamptz not null default now(),
  delivered_at     timestamptz,
  delivery_error   text
);
alter table briefings enable row level security;
