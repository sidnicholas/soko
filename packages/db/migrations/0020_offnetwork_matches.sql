-- "I have the other side": an operator records a counterparty they hold
-- outside the network against one marketplace listing (an intel lead, a
-- demand or a supply row), then tracks the deal to won or lost. Kept in its
-- own table rather than as an intel candidate or an opportunity, because the
-- other side is not a record the system discovered and can verify.
create table if not exists offnetwork_matches (
  id                    uuid primary key default gen_random_uuid(),
  -- Polymorphic reference to the listing: intel_leads.id, demands.id or
  -- supply.id. No foreign key; the listing's title is copied so the deal
  -- stays readable if the source row is later removed.
  listing_origin        text not null check (listing_origin in ('intel', 'marketplace')),
  listing_side          text not null check (listing_side in ('demand', 'supply')),
  listing_ref           uuid not null,
  listing_title         text not null,
  counterparty_name     text not null,
  counterparty_contact  text,
  terms                 text,
  price_minor           integer,
  currency              text,
  status                text not null default 'open' check (status in ('open', 'contacted', 'agreed', 'won', 'lost', 'dismissed')),
  outcome_note          text,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists offnetwork_matches_listing_idx on offnetwork_matches(listing_origin, listing_ref);

-- Holds names and contact details of people outside the system. The API
-- reads it as the table owner; row level security with no policy keeps it
-- out of reach of Supabase's anon and authenticated roles.
alter table offnetwork_matches enable row level security;
