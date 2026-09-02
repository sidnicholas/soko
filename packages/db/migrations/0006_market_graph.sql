-- Market graph + entity resolution: canonical items, their members across
-- sources, price history, and typed relationships between listings.

create table entities (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'product',
  category        text,
  canonical_key   text not null unique,
  title           text not null,
  attributes_json jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One canonical entity owns many supply/demand/signal observations across sources.
create table entity_members (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id),
  member_type  text not null check (member_type in ('supply','demand','signal')),
  member_id    uuid not null,
  created_at   timestamptz not null default now(),
  unique (member_type, member_id)
);
create index entity_members_entity_idx on entity_members(entity_id);

-- Price history: distinct observed prices per member (a new price = a new row).
create table price_observations (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entities(id),
  member_type  text not null,
  member_id    uuid not null,
  amount_minor integer not null,
  currency     text not null default 'USD',
  observed_at  timestamptz not null default now(),
  unique (member_type, member_id, amount_minor)
);
create index price_observations_entity_idx on price_observations(entity_id, observed_at);

-- Typed relationships between listings (PRICE_COMPARABLE, SUBSTITUTE_OF, ...).
create table graph_edges (
  id            uuid primary key default gen_random_uuid(),
  src_type      text not null,
  src_id        uuid not null,
  dst_type      text not null,
  dst_id        uuid not null,
  relation      text not null,
  weight        double precision not null default 1,
  metadata_json jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (src_type, src_id, dst_type, dst_id, relation)
);
create index graph_edges_src_idx on graph_edges(src_type, src_id, relation);
