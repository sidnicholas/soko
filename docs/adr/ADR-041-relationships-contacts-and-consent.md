# ADR-041: Relationships — contacts, consent, memory and retention

- Status: Accepted
- Date: 2026-10-17
- PRD v2 FR-06 (P2 slice 1); product owner decisions in the implementation plan §6

## Context

P2 needs a record of the people and organizations behind deals before any
outreach: how to reach them, what they agreed to, and what we know about
them, with source, confidence, correction history and deletion (PRD FR-06,
§10). The product owner decided that Opportunity OS is the system of record
for contacts and Pipedrive gets copies (2026-10-17), and that relationship
data is kept, archived after 90 days without activity, freshness-checked,
and purged once stale (2026-10-16). Slice 1 started before the P1 gate review
(exception recorded in ADR-033); outreach (slice 2) waits for that review.

## Decision

- **One party table.** `counterparties` (from 0001, unused until now) holds
  both PRD `organizations` (type `organization`) and `contacts` (type
  `person`), so there is no second copy of a party (PRD §7). Migration 0030
  adds display, source and lifecycle columns, and the tables
  `contact_channels`, `contact_consents`, `contact_suppressions`,
  `relationship_memories` and `counterparty_links` (party ↔ lead, candidate,
  opportunity or off-network deal, with a role). Row level security on all of
  them, no policies: only the API and workers (table owner) read them.
- **Channels** are normalized per kind (`packages/relationship`): lowercase
  email, digits-and-plus phone, host-and-path URLs. The same value on a party
  is one channel. Adding a channel whose email or phone already belongs to
  another party is refused with that party offered instead
  (`?allowDuplicate=true` overrides).
- **Consent is append-only and never assumed.** No record means outreach on
  that channel is blocked; the latest record per channel kind and purpose is
  in force; an opt-out in force wins over any grant. A grant needs a basis
  other than `none` and evidence; call recording needs `explicit` consent
  (all-party consent states). `mayContact` is the gate slice 2 will call
  before sending.
- **Memories** carry kind, source type and reference, label
  (source fact / inference / estimate / unknown), confidence, access class
  and expiry. A correction inserts a new row and marks the old one
  `superseded` (correction history). A deletion blanks the content of the
  memory and every version it superseded.
- **Every change** commits with a hash-chained audit event and
  `relationship.memory_updated.v1` (`change`: party, channel, consent,
  memory, link, archived, restored, freshness, purged). Neither carries
  personal data: ids and the kind of change only.
- **Retention** (`worker-lifecycle`, each sweep): a party with no activity
  for 90 days is archived, first freshness check due 30 days later. The check
  probes websites (DNS, then HTTP below 500) and email domains (MX). The
  party is purged only when every checkable channel positively fails; a
  timeout or DNS server failure is "could not tell", and a party with nothing
  checkable is kept and re-checked every 30 days. Any activity on an archived
  party restores it.
- **Purge and deletion requests.** A purge deletes the party and everything
  attached; members of a purged organization stay without it. Kept: SHA-256
  of kind and normalized value in `contact_suppressions` for every email and
  phone that had opted out or declined (stale purge) or for all of them
  (deletion request). A suppressed address entered again is saved with an
  opt-out already recorded. A deletion request (`POST
  /v1/relationships/:id/delete`, new `contact:delete` permission for
  operator and admin, the name typed again to confirm) also deletes the
  Pipedrive copy; if Pipedrive fails the operator is told to delete it there.
- **Pipedrive copies** (extends ADR-040). A person is copied with its
  organization (copied first), name, emails and phones only — fields beyond
  those need Pipedrive's contact-sync scope. The copy is created once and
  updated after (`crm_links` subject `counterparty`, external id namespaced
  `person:<id>` / `org:<id>` because Pipedrive ids are unique only per entity
  type and must not collide with deal ids; deal webhooks ignore party links).
  On elevation the candidate's linked contacts are copied and the deal gets
  the first person and organization; editing a contact on an elevated deal
  updates the copy. CRM failures never lose the local change.
- **API** `/v1/relationships`: reading needs `opportunity:reverify` (staff);
  every change needs `outcome:record` (operators; agents never record
  consent). **UI**: Relationships list and contact page (details, channels,
  consent with history, memories, deals, Pipedrive, delete), and a Contacts
  section on each Action Queue candidate, prefilled from the contact path the
  model found.

## Consequences

- Outreach can now be gated on recorded consent; nothing in this slice sends.
- Freshness is a weak signal: a live website does not prove a person still
  works there. It is used only to decide purges, never to imply consent.
- Pipedrive keeps its own copy until deleted; a purge for staleness removes
  the link but not the Pipedrive person (deletion requests remove both).
- Conversations, call records and relationship tasks (PRD §8 tables) come
  with outreach and calls in later slices.
