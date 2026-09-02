-- Surface graph-derived deals (arbitrage/bundle) as first-class opportunities,
-- not just edges. These have no demand/supply match, so match_id becomes
-- nullable and a kind + dedupe key distinguish + idempotently upsert them.
alter table opportunities alter column match_id drop not null;
alter table opportunities add column kind text not null default 'match';
alter table opportunities add column dedupe_key text;
alter table opportunities add column source_json jsonb;
create unique index opportunities_dedupe_uidx on opportunities (dedupe_key);
create index opportunities_kind_idx on opportunities (kind);
