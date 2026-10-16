-- CRM links (ADR-040): a candidate elevated to Pipedrive, and every Pipedrive
-- webhook event processed. Opportunity OS stays the system of record for the
-- deal's discovery, evidence and economics; the CRM holds the sales work and
-- reports status back through its webhook.

create table if not exists crm_links (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null check (provider in ('pipedrive')),
  subject_type     text not null check (subject_type in ('intel_candidate', 'opportunity', 'offnetwork_match')),
  subject_id       uuid not null,
  -- Null while the remote deal is being created; the row exists first so a
  -- second elevate of the same subject is refused rather than duplicated.
  external_id      text,
  external_url     text,
  external_status  text not null default 'creating' check (external_status in ('creating', 'open', 'won', 'lost', 'deleted')),
  external_stage_id integer,
  value            numeric(14, 2),
  currency         text,
  lost_reason      text,
  last_event_id    text,
  last_event_at    timestamptz,
  elevated_by      uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (provider, subject_type, subject_id),
  unique (provider, external_id)
);
create index if not exists crm_links_subject_idx on crm_links(subject_type, subject_id);
alter table crm_links enable row level security;

-- Each webhook event once: Pipedrive retries a delivery up to three times.
create table if not exists crm_webhook_events (
  provider     text not null,
  event_id     text not null,
  link_id      uuid references crm_links(id) on delete set null,
  action       text not null,
  entity_id    text,
  received_at  timestamptz not null default now(),
  primary key (provider, event_id)
);
alter table crm_webhook_events enable row level security;
