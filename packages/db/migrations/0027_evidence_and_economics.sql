-- Evidence and versioned deal economics (PRD v2 FR-04, §7; P1 slice 3; ADR-039).
--
-- opportunity_evidence keeps what a lead or candidate rests on, as captured:
-- the source page, the counterpart result used, stated facts, the contact
-- path. Each row carries a content hash, so the evidence behind a decision can
-- be reproduced later even if the page changes or disappears.
--
-- opportunity_economics_versions keeps every economics calculation of a
-- candidate (packages/scoring deal-economics), append-only, numbered per
-- subject. The candidate row holds the latest copy for the queue.
--
-- Subjects are referenced polymorphically (type + id), like offnetwork_matches:
-- intel leads and candidates now, mission and graph opportunities later.

create table if not exists opportunity_evidence (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('intel_lead', 'intel_candidate', 'opportunity')),
  subject_id    uuid not null,
  kind          text not null check (kind in ('source_page', 'counterpart', 'fact', 'contact', 'price_observation')),
  url           text,
  title         text,
  excerpt       text,
  -- source_fact: stated in the source. inference / estimate: derived. unknown: absent.
  label         text not null check (label in ('source_fact', 'inference', 'estimate', 'unknown')),
  observed_at   timestamptz,
  captured_at   timestamptz not null default now(),
  content_hash  text not null,
  unique (subject_type, subject_id, kind, content_hash)
);
create index if not exists opportunity_evidence_subject_idx on opportunity_evidence(subject_type, subject_id);
alter table opportunity_evidence enable row level security;

create table if not exists opportunity_economics_versions (
  id              uuid primary key default gen_random_uuid(),
  subject_type    text not null check (subject_type in ('intel_candidate', 'opportunity')),
  subject_id      uuid not null,
  version         integer not null,
  model_version   text not null,
  mode            text not null check (mode in ('brokerage', 'principal', 'service')),
  inputs          jsonb not null,
  outputs         jsonb not null,
  net_low_usd     numeric(14, 2) not null,
  net_high_usd    numeric(14, 2) not null,
  expected_mid_usd numeric(14, 2) not null,
  tier            text not null check (tier in ('high', 'medium', 'low', 'marginal', 'negative')),
  gates           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  unique (subject_type, subject_id, version)
);
create index if not exists opportunity_economics_subject_idx on opportunity_economics_versions(subject_type, subject_id, version desc);
alter table opportunity_economics_versions enable row level security;
