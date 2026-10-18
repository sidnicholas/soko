# Opportunity OS — PRD v2 Implementation Plan

**Date:** 2026-10-15 · **PRD:** `docs/Opportunity_OS_Integrated_PRD_v2.md` · **Decision record:** ADR-033 (adoption), ADR-034 (delegation, proposed), ADR-035 (intel), ADR-036 (P0)

PRD v2 is implemented in phases with acceptance gates (PRD §14, §16). This pass completed the code for P0 (stabilize). P0 is not closed until the operator steps at the end of this document are done in production. P1–P5 have not started; several of their slices are blocked on product decisions in PRD §17.

## 1. Discrepancies between the PRD/audit and the code (PRD §16.1)

| # | PRD or audit says | Code shows | Resolution |
| --- | --- | --- | --- |
| D1 | 31 tables / 23 migrations | True before this pass; now 24 migrations (0024 adds no table) | Updated in project memory |
| D2 | Events replay without duplication (P0 gate) | The outbox relay read unpublished rows without locking, so two relays could publish the same event | Fixed: `relayOutboxBatch` locks with `for update skip locked` (ADR-036) |
| D3 | FR-04: suppress echo-embedding graph arbitrage | No switch existed; about 44 noise deals in production | Fixed: `GRAPH_ARBITRAGE_DEALS=auto` (off with echo embeddings) expires open ones |
| D4 | §10: close the Supabase REST mission-write bypass | 0002 insert/update policies let an owner write missions over REST | Fixed: migration 0024; tested under the `authenticated` role |
| D5 | §10: inbound rate limiting | None | Fixed: per-sender hourly limit on the four message webhooks |
| D6 | §3.5: one canonical deal id end to end | None. Intel candidates, off-network deals, opportunities and transactions are separate records | Open. Introduce as a column on existing records with the first P2/P3 slice (ADR-033) |
| D7 | §3.2: workers never write around policy | Connectors, lifecycle and intel workers write discovery data directly (non-binding). The settlement timer activity auto-refunds and auto-releases below threshold with no human token, by ADR-029 design | Allowed for non-binding data. Timer behaviour stays on test rails; revisit before any live rail (ADR-033) |
| D8 | FR-01: a source registry | Three partial registries already: `intel_query_sources` (runtime search sources), `intel_sources` (host yield), and the connector registry in code | Resolved by P1 slice 1: `intel_query_sources` renamed to `source_registry`; built-in venues and connectors are rows; `intel_sources` kept as lead-host yield |
| D9 | FR-07: map channel identities to counterparties | `counterparties` exists; no channel identity lookup; inbound messages are always recorded as supply signals | P2 slice |
| D10 | §5/§12: a `messaging` package | Messaging lives in `apps/api/src/messaging` | Keep there until a second host needs it |
| D11 | FR-10: e-sign adapter | `verifiers-sdk` has a deterministic e-signature reference verifier only | P3: real provider behind the existing verifier interface |
| D12 | FR-11: keep Stripe/Circle separate from legal escrow | Code and UI call milestone holds "escrow" | P3/P4: relabel to "payment hold" where no licensed escrow is involved |
| D13 | §8 event names | None of the 24 proposed names exist; `opportunity.economics_updated` overlaps `opportunity.score_changed` | Added per slice; `opportunity.economics_updated.v1` kept as its own event (slice 3), since intel candidates are not opportunities |
| D14 | §13: Apify actors | No Apify code | P1, after per-source terms review |
| D16 | Vision: industry-agnostic brokerage of any product or service | Intel searched only for buyers of the user's own web services (since `1c197db`); missed in the first version of this list | Fixed 2026-10-16: category-agnostic venues and broker framing in the prompts |
| D15 | Audit: suite 230 pass / 1 skip | Superseded by the run recorded in project memory §7 | — |

## 2. Feature-to-owner matrix (PRD §16.2)

| FR | Package(s) | Host | Existing tables to extend | New tables (only when needed) | Policy / provider | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| FR-01 Source discovery and governance | `connectors-sdk`, `intel` | `worker-intel` (later `worker-source-registry`) | `intel_query_sources`, `intel_sources` | `source_policy_reviews`, `source_runs`, `ingestion_quarantine` | Official API first; Apify after terms review | P1 |
| FR-02 Supply intelligence | `discovery`, `intel` | `worker-connectors`, `worker-intel` | `supply`, `signals`, `price_observations` | `supply_capacity` | Verified vs inferred surplus | P1 |
| FR-03 Demand intelligence | `demand`, `intel` | `worker-intel` | `demands`, `signals`, `intel_leads` | `demand_hypotheses` | Hypothesis never shown as a confirmed buyer | P1 |
| FR-04 Synthesis and economics | `scoring`, `discovery` | `worker-lifecycle` | `matches`, `opportunities` | `opportunity_economics_versions`, `opportunity_evidence` | Negative net economics gated; profit-first ranking | P0 (suppression) / P1 |
| FR-05 Deal strategy | new `deal-strategy` | `api` | `opportunities`, `transactions` | `deal_strategies`, `brokerage_fee_terms`, `deal_disclosures` | Counsel-reviewed templates; disclosure policy | P3 |
| FR-06 Relationship memory | new `relationship` | `api`, later `worker-relationship` | `counterparties` | `organizations`, `contacts`, `contact_channels`, `contact_consents`, `conversations`, `conversation_messages`, `relationship_memories` | Consent, retention, encryption | P2 |
| FR-07 Outreach and negotiation | `negotiation`, `apps/api/src/messaging` | `api`, later `worker-outreach` | `negotiations` | `relationship_tasks` | Approval-first; opt-out; CAN-SPAM/TCPA | P2 |
| FR-08 Trust and risk | `risk`, new `trust` | `api` | `counterparties`, `evidence` | `counterparty_verifications`, `trust_attestations` | Provider callback, never model inference | P3 |
| FR-09 Deal room | new `dealroom` | `web`, `api` | `transactions`, `settlement_plans` | `deal_rooms`, `deal_room_access` | Party isolation at API and DB | P3 |
| FR-10 Contracts and obligations | new `documents`, `verifiers-sdk` | `api` | `evidence` | `documents`, `document_versions`, `signature_requests`, `contract_obligations` | Material change re-signs | P3 |
| FR-11 Payment, escrow, stablecoins | `settlement`, `escrow` | `api`, `worker-temporal` | `settlement_plans`, `settlement_milestones` | `payment_assurances`, `provider_accounts`, `reconciliation_entries` | Licensed partner; signed webhooks | P4 |
| FR-12 Insurance and logistics | new `fulfillment`, `insurance` | later `worker-fulfillment` | `evidence` | `shipments`, `inspections`, `customs_documents`, `insurance_policies`, `claims` | Delivery alone never releases funds | P4 |
| FR-13 Exceptions and disputes | `domain`, `settlement` | `api` | `settlement_plans` (dispute/freeze) | `deal_exceptions` | No silent weaker-rail fallback | P4 |
| FR-14 Learning | new `learning`, `scoring`, `intel` | later `worker-learning` | `outcomes`, `intel_candidates` | `learning_evaluations`, `source_yield_metrics` | Held-out evaluation; no training on private messages without permission | P5 (baseline in P0) |

## 3. Phase plan

| Phase | Scope | Gate (PRD §14) | Status |
| --- | --- | --- | --- |
| P0 Stabilize | REST write bypass, webhook validation, graph noise, outbox relay, baseline, ADRs | Unauthorized REST write blocked; events replay without duplication; measurable source yield | Code done; production steps below |
| P1 Discovery expansion | Unified source registry, Apify, independent supply/demand, hypotheses, provenance, profit economics, watchlist | Vetted sources only; reproducible evidence; budget adherence; better verified leads per dollar | Slices 1 (source registry, ADR-037), 2 (supply and demand intelligence, ADR-038) and 3 (deal economics and evidence, ADR-039) built 2026-10-16; slice 1 resolves D8; slice 4 (Apify ingestion, ADR-042) built 2026-10-17, resolves D14 in code (no actor registered until a site grants permission) |
| P2 Relationship and outreach | CRM, consent, threading, client brief, digest, approval-first outbound | No unauthorized sends; correct threading and opt-outs; memory correction | Slice 1 (contacts, consent, memory, retention, Pipedrive person/org copies; ADR-041) built 2026-10-17 ahead of the P1 gate review (ADR-033 exception). Slice 2 (approval-first email outreach over a Hostinger mailbox, reply threading, opt-outs; ADR-045) and slice 3 (daily brief with source citations; ADR-046) built 2026-10-17; follow-up cadence and closed archive for contacted candidates (ADR-047) built 2026-10-18 |
| P3 Broker deal execution | Strategy, fee protection, e-sign, deal rooms, KYB/KYC | Full sandbox deal with signed terms; isolation tests | Blocked on §17: jurisdictions, counterparty accounts; counsel templates |
| P4 Regulated money and fulfillment | Licensed escrow, stablecoin option, freight, customs, reconciliation, exceptions | Legal signoff; provider sandbox end to end; no premature release | Blocked on §17: providers, freight classes; licensed partner |
| P5 Learning and selective autonomy | Calibration, scheduling, delegation grants (ADR-034) | Measured uplift; exposure ceilings; kill switch | Blocked on §17: exposure and spend caps |

## 4. What this pass built (P0)

- Migration `0024_missions_rest_read_only.sql` and `tests/e2e/rls-rest-roles.test.ts` (runs as Supabase's `authenticated` role).
- `relayOutboxBatch` in `packages/db/src/outbox.ts`, used by `worker-outbox`; `tests/e2e/outbox-relay.test.ts` (concurrent relays, failure mid-batch).
- `GRAPH_ARBITRAGE_DEALS` (`auto`/`on`/`off`), `opportunitiesFromGraph({ arbitrage })`, `expireGraphOpportunities`, wired into `worker-lifecycle`.
- `WindowRateLimiter` and `INBOUND_MESSAGES_PER_HOUR` on the inbound message webhooks.
- `GET /v1/analytics/yield?days=30` (staff): intel spend and yield per day and per search provider, opportunity funnel by kind and status.
- ADR-033 to ADR-036.

## 5. Operator steps to close P0

1. **Done 2026-10-15.** Apply migration 0024 to Supabase (no code depends on it, so it can go before or after the deploy): `DATABASE_URL=<prod> pnpm db:migrate`, or run the file in the SQL editor and insert `0024_missions_rest_read_only.sql` into `schema_migrations`.
2. **Done 2026-10-15.** Confirm in production that 0022 and 0024 hold: as the `authenticated` role, selecting from `users` returns no rows and inserting into `missions` fails with a row-level security error.
3. **Done 2026-10-15** (first run published a 1,374-event backlog). Add `worker-outbox` as a Railway cron (`pnpm --filter @opportunity-os/worker-outbox start -- --once`, every 5 minutes), same pattern as the other workers.
4. Leave `GRAPH_ARBITRAGE_DEALS` unset (auto). The next lifecycle sweep expires the open arbitrage deals. Set `EMBEDDING_PROVIDER` and a key to bring them back.
5. **eBay done 2026-10-15** (204 real notifications verified, 201 each); the rest when each provider is configured. Verify webhook signatures with real notifications: Stripe and Circle sandbox events, an eBay deletion notification, and Twilio and WhatsApp if those channels are used.
6. Read `GET /v1/analytics/yield` after a week of runs to set the baseline before switching search or model providers.

## 6. Product owner decisions (PRD §17)

Recorded 2026-10-16.

| Decision | Answer | How it is applied |
| --- | --- | --- |
| Jurisdictions | None chosen initially | No jurisdiction gate. Regulatory flags (licensing, export, consent) still mark individual deals for review. |
| Prohibited / restricted categories | No banned categories | The former `prohibited_for_v1` categories (firearms, ammunition, pharmaceuticals, alcohol, tobacco, securities, adult, hazardous materials) are `review_required`: ingested and surfaced, flagged for a licensing review, never transacted automatically (`isTransactableInV1` stays "allowed only"). Unknown, unmapped categories stay out until mapped (PRD §3.4 default deny). |
| Capital exposure caps | None | `DEAL_MAX_CAPITAL_USD` unset = no per-deal cap. Note for P5: delegated autonomy (ADR-034) still needs an aggregate exposure ceiling and kill switch before any money moves without a person. |
| Automation spend caps | Unchanged | `INTEL_DAILY_BUDGET_USD` remains the daily ceiling. |
| First outreach channels | Whichever is most promising first | P2 starts with email (most leads expose an email or contact form; marketplace messaging is the platform's own channel and is not automated). Phone follows once the dedicated number exists. |
| Calls | Recorded and transcribed | Through RingCentral on a new number for this business (to be provisioned by the owner). Every recorded call must announce recording at the start and keep the consent: many US states and other countries require all-party consent. |
| Retention | Keep relationship data; archive after 90 days; freshness-check and purge stale data | Records untouched for 90 days move to an archive; a periodic freshness check re-verifies archived facts (contact still valid, business still operating) and purges what has gone stale. A person's deletion request is honoured regardless (PRD §10 DSAR). |
| Contact system of record | Opportunity OS (2026-10-17) | Organizations, people, channels, consent, provenance, retention and purge live in Opportunity OS (PRD FR-06); when a deal is elevated, its person and organization are created or updated in Pipedrive and linked (ADR-040). Pipedrive is never the source of contact truth. |
| Counterparty accounts | Not decided | Invitation-only deal rooms assumed until decided. |
| Escrow / insurance providers, freight classes | Not decided | Needed before P3/P4 slices that use them. |
| Sources without permission | Owner may accept the risk (2026-10-17) | `owner_risk_acceptance` basis for Apify actors only, admin-only, a written note, at most 90 days, recorded as such (ADR-043). First use: `apify~facebook-marketplace-scraper`, against Meta's terms; seller identity not stored. |
| Model cost | Use comparable open-weight models | Both model tiers move to open-weight models through OpenRouter (detection DeepSeek V4 Flash, assessment DeepSeek V4 Pro), with Claude as the fallback when the host fails. Compare quality on `/yield` and the queue before treating as settled. |

## 7. P1 gate review (2026-10-17)

Read from production (read-only queries) on 2026-10-17, comparing the
Serper + open-weight period (lanes `demand`/`supply`, 2026-10-16 02:33 UTC
to 2026-10-17 15:00 UTC) with the Brave + Claude baseline (54 runs through
2026-10-16: $4.83 spent, 59 leads, 1 actionable).

| PRD §14 gate | Evidence | Result |
| --- | --- | --- |
| Better verified leads per dollar | $1.10 spent (search $0.30, model $0.80), 95 leads, 7 actionable (6 VERIFY NEXT, 1 ACT NOW): **$0.16 per actionable** against $4.83, **86 leads per $** against 12. | Pass |
| Budget adherence | Highest day $1.21 against `INTEL_DAILY_BUDGET_USD` 2; on 2026-10-16, while the cap was $1, runs stopped as `budget_exhausted`. | Pass |
| Vetted sources only | Every active source has a recorded review: 8 search venues (public search index), 2 connectors (official API terms), 1 Apify actor on owner risk acceptance (ADR-043, recorded as such). | Pass, with the ADR-043 exception |
| Reproducible evidence | 31 of 48 candidates since 2026-10-16 have evidence rows, 39 have an economics version; the gap includes candidates assessed before slice 3 was deployed that day. | Pass, to confirm: every candidate after the slice 3 deploy should have both |

Operator judgment so far: of the 7 actionable, 2 contacted (sunglasses
liquidation, lathe), 2 dismissed as not relevant (both Upwork sourcing
jobs from the demand lane), 3 open. No wins yet; two days is a small
sample.

**Decision: P1 gate passed (2026-10-17).** P2 slice 2 (email outreach) may
start once a sending provider and domain are chosen.

Follow-ups: record the model used per run in `intel_runs.notes` (today the
open-weight and Claude runs cannot be told apart in the data, so the
quality comparison rests on outcomes, not attribution); re-check evidence
coverage on candidates after the slice 3 deploy; tune the demand lane
against outsourced-sourcing job posts if dismissals continue.

