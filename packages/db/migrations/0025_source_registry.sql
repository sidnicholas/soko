-- Source registry (PRD v2 FR-01, P1 slice 1; ADR-037).
--
-- One table for every place discovery reads from: search venues (queried
-- through the search provider's index with a site: filter), official-API
-- connectors, and later Apify actors. It replaces three partial registries:
-- intel_query_sources (runtime sources, renamed here, so its rows and ids
-- carry over), the built-in venue list that lived in packages/intel code, and
-- the connector list in worker-connectors. intel_sources stays as what it is:
-- yield of the hosts leads actually came from.
--
-- A source cannot be active until its permission policy is satisfied: a
-- permission basis, a robots/terms assessment and an unexpired terms review
-- (enforced by packages/intel source-policy.ts, re-checked every run).
-- source_policy_reviews keeps every review decision; source_runs records every
-- search a source took part in, with cost and yield, for auto-pause and
-- reporting.

alter table intel_query_sources rename to source_registry;
alter index if exists intel_query_sources_status_idx rename to source_registry_status_idx;

alter table source_registry
  add column if not exists kind text not null default 'search_venue',
  add column if not exists url text,
  add column if not exists markets jsonb not null default '[]'::jsonb,
  add column if not exists api_available boolean not null default false,
  add column if not exists apify_actor_id text,
  add column if not exists apify_actor_version text,
  add column if not exists permission_basis text not null default 'none',
  add column if not exists robots_tos_assessment text,
  add column if not exists data_use_constraints text,
  add column if not exists terms_reviewed_at timestamptz,
  add column if not exists terms_review_due_at timestamptz,
  add column if not exists contact_path text,
  add column if not exists min_interval_minutes integer,
  add column if not exists cost_per_run_usd numeric(10, 4),
  add column if not exists max_daily_usd numeric(10, 4),
  add column if not exists health text not null default 'unknown',
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_run_at timestamptz;

alter table source_registry drop constraint if exists intel_query_sources_status_check;
alter table source_registry drop constraint if exists source_registry_status_check;
-- proposed: submitted, waiting for a permission-policy review before it can run.
alter table source_registry add constraint source_registry_status_check check (status in ('proposed', 'active', 'paused', 'rejected'));
alter table source_registry drop constraint if exists source_registry_kind_check;
alter table source_registry add constraint source_registry_kind_check check (kind in ('search_venue', 'connector', 'apify_actor'));
alter table source_registry drop constraint if exists source_registry_permission_basis_check;
alter table source_registry add constraint source_registry_permission_basis_check
  check (permission_basis in ('none', 'public_search_index', 'official_api_terms', 'written_permission', 'provider_contract'));
alter table source_registry drop constraint if exists source_registry_health_check;
alter table source_registry add constraint source_registry_health_check check (health in ('unknown', 'ok', 'degraded', 'failing'));

alter table source_registry drop constraint if exists intel_query_sources_domain_orientation_key;
alter table source_registry drop constraint if exists source_registry_kind_domain_orientation_key;
alter table source_registry add constraint source_registry_kind_domain_orientation_key unique (kind, domain, orientation);

-- Runtime sources submitted before this migration were searched without a
-- policy review. They keep their place but wait for one now.
update source_registry
   set permission_basis = 'public_search_index'
 where kind = 'search_venue' and permission_basis = 'none';
update source_registry
   set status = 'proposed', status_reason = 'awaiting_policy_review', updated_at = now()
 where status = 'active' and terms_reviewed_at is null;

-- Every review decision, append-only. The registry row holds the current state.
create table if not exists source_policy_reviews (
  id                    uuid primary key default gen_random_uuid(),
  source_id             uuid not null references source_registry(id) on delete cascade,
  decision              text not null check (decision in ('approved', 'rejected')),
  permission_basis      text not null,
  robots_tos_assessment text,
  data_use_constraints  text,
  terms_review_due_at   timestamptz,
  notes                 text,
  reviewed_by           uuid,
  reviewer_label        text,
  created_at            timestamptz not null default now()
);
create index if not exists source_policy_reviews_source_idx on source_policy_reviews(source_id, created_at desc);
alter table source_policy_reviews enable row level security;

-- One row per search (or connector call) a source took part in.
create table if not exists source_runs (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid references source_registry(id) on delete set null,
  intel_run_id  uuid references intel_runs(id) on delete set null,
  query         text not null,
  results       integer not null default 0,
  new_results   integer not null default 0,
  leads         integer not null default 0,
  cost_usd      numeric(10, 6) not null default 0,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists source_runs_source_idx on source_runs(source_id, created_at desc);
create index if not exists source_runs_query_idx on source_runs(query);
alter table source_runs enable row level security;

-- Built-in search venues, moved out of packages/intel/src/queries.ts (the
-- category-agnostic pool of 2026-10-16). Recorded as reviewed by this
-- migration on the basis below; an operator re-reviews them by the due date.
insert into source_registry
  (kind, name, domain, orientation, topics, access_method, status, status_reason, origin,
   permission_basis, robots_tos_assessment, data_use_constraints, terms_reviewed_at, terms_review_due_at)
select 'search_venue', v.name, v.domain, v.orientation, v.topics::jsonb, 'search_index', 'active', null, 'builtin',
       'public_search_index',
       'Queried only through the search provider''s index with a site: filter; no page on the site is fetched or scraped (ADR-014).',
       'Search result titles and snippets only; a lead keeps a short summary and the result URL. No bulk copying of listings.',
       now(), now() + interval '180 days'
from (values
  ('TradeKey buy offers', 'tradekey.com', 'demand', '["buy offers", "buying request bulk"]'),
  ('go4WorldBusiness buying leads', 'go4worldbusiness.com', 'demand', '["buying leads"]'),
  ('EC21 buy offers', 'ec21.com', 'demand', '["buy offers"]'),
  ('Reddit buyers', 'reddit.com', 'demand', '["WTB bulk wholesale", "looking for a supplier", "looking for a manufacturer", "where can I buy in bulk", "need a vendor for my business"]'),
  ('Upwork sourcing jobs', 'upwork.com', 'demand', '["product sourcing agent job", "find suppliers job", "procurement specialist job"]'),
  ('Reddit sellers', 'reddit.com', 'supply', '["surplus inventory for sale", "liquidating inventory", "excess stock wholesale lot", "closeout pallets for sale"]'),
  ('Surplus Record', 'surplusrecord.com', 'supply', '["surplus equipment"]'),
  ('Machinio used equipment', 'machinio.com', 'supply', '["used equipment for sale"]'),
  ('Reddit business problems', 'reddit.com', 'problem', '["small business need help finding a company", "need a contractor urgently", "recommend a vendor for my business"]'),
  ('Shopify Community', 'community.shopify.com', 'problem', '["need someone to fix"]')
) as v(name, domain, orientation, topics)
on conflict (kind, domain, orientation) do nothing;

-- Official-API connectors, moved out of worker-connectors. Whether each runs
-- still depends on its credentials or opt-in flag; a paused row stops it.
insert into source_registry
  (kind, external_id, name, domain, url, orientation, topics, access_method, api_available, status, origin,
   permission_basis, robots_tos_assessment, data_use_constraints, terms_reviewed_at, terms_review_due_at)
values
  ('connector', 'ebay-browse', 'eBay Browse API', 'ebay.com', 'https://developer.ebay.com/api-docs/buy/browse/overview.html', 'supply', '[]'::jsonb,
   'official_api', true, 'active', 'connector', 'official_api_terms',
   'Official eBay Browse API under the eBay API License Agreement, app token by OAuth client credentials. Marketplace Account Deletion endpoint registered 2026-10-11 and signature-verified 2026-10-15.',
   'Listing id, title, description, category, price, URL, seller username and feedback, item location. No buyer data. Deletion notifications are acknowledged; no eBay user data is stored beyond listing seller fields.',
   now(), now() + interval '180 days'),
  ('connector', 'reverb-listings', 'Reverb listings API', 'reverb.com', 'https://reverb.com/page/api', 'supply', '[]'::jsonb,
   'official_api', true, 'active', 'connector', 'official_api_terms',
   'Reverb public listings API, keyless (optional token for rate limits).',
   'Listing title, description, category, price, URL, shop name and page, condition. No buyer data.',
   now(), now() + interval '180 days')
on conflict (kind, domain, orientation) do nothing;

insert into source_policy_reviews (source_id, decision, permission_basis, robots_tos_assessment, data_use_constraints, terms_review_due_at, notes, reviewer_label)
select id, 'approved', permission_basis, robots_tos_assessment, data_use_constraints, terms_review_due_at,
       'Baseline review recorded when the registry was created; re-review by the due date.', 'migration 0025'
from source_registry r
where r.origin in ('builtin', 'connector')
  and not exists (select 1 from source_policy_reviews p where p.source_id = r.id);

-- Compatibility for code deployed before this migration, which still reads and
-- writes intel_query_sources. security_invoker makes the base table's row level
-- security apply to whoever queries the view. Dropped by a later migration once
-- the code that uses source_registry is deployed.
create or replace view intel_query_sources with (security_invoker = true) as
  select id, external_id, name, domain, orientation, topics, sector, geography, signal_type, access_method,
         notes, priority, evidence_url, status, status_reason, origin, created_at, updated_at
  from source_registry
  where kind = 'search_venue';
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on intel_query_sources from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on intel_query_sources from authenticated';
  end if;
end $$;
