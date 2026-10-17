-- Relationships: contacts and consent (PRD v2 FR-06, P2 slice 1; ADR-041).
--
-- counterparties stays the one party table (PRD §7: no duplicate truth):
-- type 'organization' is the PRD's organizations, type 'person' its contacts.
-- It gains display and lifecycle fields; channels, consents, memories and
-- links to deals hang off it. Opportunity OS is the system of record for
-- contacts; Pipedrive gets copies through crm_links.
--
-- Retention (product owner, 2026-10-16): records are kept; a party untouched
-- for 90 days is archived; archived parties are freshness-checked and purged
-- when their information has gone stale. Opt-outs survive a purge as hashed
-- identifiers in contact_suppressions, so a purged party is never re-contacted.

alter table counterparties
  add column if not exists display_name text,
  add column if not exists organization_id uuid references counterparties(id) on delete set null,
  add column if not exists role_title text,
  add column if not exists website text,
  add column if not exists location text,
  add column if not exists source_type text,
  add column if not exists source_url text,
  add column if not exists status text not null default 'active',
  add column if not exists last_activity_at timestamptz not null default now(),
  add column if not exists archived_at timestamptz,
  add column if not exists freshness_checked_at timestamptz,
  add column if not exists freshness_due_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table counterparties drop constraint if exists counterparties_status_check;
alter table counterparties add constraint counterparties_status_check check (status in ('active', 'archived'));
-- Existing rows predate these defaults' meaning; give them a creation-time activity.
update counterparties set last_activity_at = created_at where last_activity_at > created_at;
create index if not exists counterparties_status_idx on counterparties(status, last_activity_at);

create table if not exists contact_channels (
  id               uuid primary key default gen_random_uuid(),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  kind             text not null check (kind in ('email', 'phone', 'website', 'marketplace_profile', 'social', 'address', 'other')),
  value            text not null,
  normalized_value text not null,
  label            text,
  is_primary       boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'invalid', 'bounced')),
  -- source_fact: stated by the party or its own page. inference: deduced.
  source_label     text not null default 'source_fact' check (source_label in ('source_fact', 'inference', 'unknown')),
  source_url       text,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (counterparty_id, kind, normalized_value)
);
create index if not exists contact_channels_lookup_idx on contact_channels(kind, normalized_value);
alter table contact_channels enable row level security;

-- Consent history, append-only; the latest row per (party, channel kind, purpose) is in force.
create table if not exists contact_consents (
  id               uuid primary key default gen_random_uuid(),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  channel_kind     text not null check (channel_kind in ('email', 'phone', 'sms', 'whatsapp', 'any')),
  purpose          text not null check (purpose in ('outreach', 'call_recording', 'marketing')),
  status           text not null check (status in ('granted', 'denied', 'opted_out')),
  basis            text not null check (basis in ('explicit', 'public_business_contact', 'existing_relationship', 'none')),
  evidence         text,
  recorded_by      uuid,
  recorded_at      timestamptz not null default now(),
  expires_at       timestamptz
);
create index if not exists contact_consents_party_idx on contact_consents(counterparty_id, channel_kind, purpose, recorded_at desc);
alter table contact_consents enable row level security;

-- Hashed opt-outs that outlive a purge (sha256 of kind + normalized value).
create table if not exists contact_suppressions (
  identifier_hash  text primary key,
  kind             text not null,
  reason           text not null,
  created_at       timestamptz not null default now()
);
alter table contact_suppressions enable row level security;

-- Structured relationship memory (PRD FR-06): each fact with its source,
-- confidence, access class and expiry; a correction supersedes, never edits.
create table if not exists relationship_memories (
  id               uuid primary key default gen_random_uuid(),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  kind             text not null check (kind in ('fact', 'preference', 'commitment', 'objection', 'red_flag', 'buying_cycle', 'outcome', 'note')),
  content          text not null,
  source_type      text not null check (source_type in ('lead', 'candidate', 'operator', 'conversation', 'call', 'crm')),
  source_ref       text,
  source_label     text not null check (source_label in ('source_fact', 'inference', 'estimate', 'unknown')),
  confidence       numeric(4, 3) not null default 1,
  access           text not null default 'internal' check (access in ('internal', 'restricted')),
  observed_at      timestamptz,
  expires_at       timestamptz,
  status           text not null default 'active' check (status in ('active', 'superseded', 'deleted')),
  superseded_by    uuid references relationship_memories(id) on delete set null,
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create index if not exists relationship_memories_party_idx on relationship_memories(counterparty_id, status, created_at desc);
alter table relationship_memories enable row level security;

-- Which parties a lead, candidate or deal involves, and in what role.
create table if not exists counterparty_links (
  id               uuid primary key default gen_random_uuid(),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  subject_type     text not null check (subject_type in ('intel_lead', 'intel_candidate', 'opportunity', 'offnetwork_match')),
  subject_id       uuid not null,
  role             text not null check (role in ('buyer', 'seller', 'provider', 'decision_maker', 'other')),
  created_at       timestamptz not null default now(),
  unique (counterparty_id, subject_type, subject_id, role)
);
create index if not exists counterparty_links_subject_idx on counterparty_links(subject_type, subject_id);
alter table counterparty_links enable row level security;

-- Pipedrive copies of parties.
alter table crm_links drop constraint if exists crm_links_subject_type_check;
alter table crm_links add constraint crm_links_subject_type_check check (subject_type in ('intel_candidate', 'opportunity', 'offnetwork_match', 'counterparty'));
