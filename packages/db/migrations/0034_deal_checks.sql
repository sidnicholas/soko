-- Good-deal filter (ADR-044): every new actor listing is priced against
-- comparable eBay listings; only those well under market become supply leads
-- for the intel pipeline (buyer search, economics, Action Queue). One check per
-- observation, kept as the evidence for the decision.

create table if not exists deal_checks (
  id                uuid primary key default gen_random_uuid(),
  observation_id    uuid not null unique references source_observations(id) on delete cascade,
  source_id         uuid not null references source_registry(id) on delete cascade,
  supply_id         uuid references supply(id) on delete set null,
  query             text,
  price_minor       bigint,
  currency          text,
  comps             integer not null default 0,
  comp_median_minor bigint,
  discount          numeric(6, 4),
  -- A recent buyer request this listing matches (lower bar, assessed first).
  demand_term       text,
  verdict           text not null check (verdict in ('good_deal', 'fair', 'overpriced', 'no_comps', 'no_price')),
  comps_json        jsonb not null default '[]',
  lead_id           uuid references intel_leads(id) on delete set null,
  checked_at        timestamptz not null default now()
);
create index if not exists deal_checks_source_idx on deal_checks(source_id, checked_at desc);
create index if not exists deal_checks_verdict_idx on deal_checks(verdict, checked_at desc);
alter table deal_checks enable row level security;
