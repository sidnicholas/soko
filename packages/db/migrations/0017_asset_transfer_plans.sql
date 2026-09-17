-- §19 crypto-asset expansion backlog item 1: give CircleNftRail (and any
-- future AssetTransferRail) somewhere to persist a plan. One row per
-- transfer (not milestone-based like settlement_plans/milestones) — an asset
-- transfer moves a single object/position, not a phased amount.
create table asset_transfer_plans (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  provider       text not null,
  asset_kind     text not null,
  asset_json     jsonb not null,
  to_address     text not null,
  reference      text,
  external_ref   text,
  status         text not null default 'pending' check (status in ('pending','confirmed','failed','reclaimed')),
  created_at     timestamptz not null default now(),
  executed_at    timestamptz
);
create index asset_transfer_plans_transaction_id_idx on asset_transfer_plans(transaction_id);
