-- Multi-channel discovery + learning loop: raw signals upstream of supply/demand,
-- and realized outcomes downstream of transactions (Signals -> ... -> Outcomes).

create table signals (
  id                    uuid primary key default gen_random_uuid(),
  channel               text not null check (channel in ('public_web','official_api','browser_extension','user_submitted','merchant_feed','request_mining','internal')),
  kind                  text not null check (kind in ('supply','demand')),
  source_id             text not null,
  external_ref          text,
  title                 text,
  description           text not null,
  category              text,
  price                 jsonb,
  geo_point             jsonb,
  raw_json              jsonb not null default '{}',
  content_hash          text not null,
  source_reliability    double precision not null default 0.5,
  status                text not null default 'captured' check (status in ('captured','resolved','discarded')),
  resolved_entity_type  text,
  resolved_entity_id    uuid,
  captured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);
create index signals_status_idx on signals(status);
create index signals_kind_category_idx on signals(kind, category);
-- Re-ingesting the same source item updates the signal in place.
create unique index signals_source_uidx on signals(source_id, external_ref);

create table outcomes (
  id                uuid primary key default gen_random_uuid(),
  opportunity_id    uuid references opportunities(id),
  transaction_id    uuid references transactions(id),
  status            text not null check (status in ('won','lost','expired','cancelled')),
  realized_amount   jsonb,
  realized_profit   jsonb,
  days_to_close     double precision,
  shipping_cost     jsonb,
  notes             text,
  metadata_json     jsonb not null default '{}',
  created_at        timestamptz not null default now()
);
create index outcomes_opportunity_idx on outcomes(opportunity_id);
create index outcomes_status_idx on outcomes(status);
