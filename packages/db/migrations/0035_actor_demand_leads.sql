-- Actor demand becomes demand leads (ADR-042 addendum 2): buyer items from
-- actor sources (Alibaba RFQs, Craigslist "WANTED" posts) are raised as demand
-- leads for the demand lane, once each. Records which lead an observation
-- raised, or that it was considered and not raised.

alter table source_observations
  add column if not exists lead_id uuid references intel_leads(id) on delete set null,
  add column if not exists lead_checked_at timestamptz;
create index if not exists source_observations_demand_pending_idx on source_observations(first_seen_at desc) where kind = 'demand' and lead_checked_at is null;
