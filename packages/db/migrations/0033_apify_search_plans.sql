-- Apify search plans (ADR-042 addendum): an actor source can build its search
-- URLs each run instead of repeating a fixed input. Terms come first from
-- recent buyer demand, then from a keyword × city list in rotation; each
-- search's yield (items credited through the item's search-URL field) decides
-- what drops down the rotation.

alter table source_registry add column if not exists apify_search jsonb;

create table if not exists apify_run_searches (
  id            uuid primary key default gen_random_uuid(),
  apify_run_id  uuid not null references apify_runs(id) on delete cascade,
  source_id     uuid not null references source_registry(id) on delete cascade,
  term          text not null,
  city          text,
  url           text not null,
  origin        text not null check (origin in ('demand', 'list')),
  items         integer not null default 0,
  items_new     integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists apify_run_searches_source_idx on apify_run_searches(source_id, term, city, created_at desc);
create index if not exists apify_run_searches_run_idx on apify_run_searches(apify_run_id);
alter table apify_run_searches enable row level security;
