# Opportunity OS — Project Memory (Implementation State)

**Status:** V1 in active build — Phases 0–4 complete; Supabase JWT auth live (2026-10-02); the AIOOS opportunity-intelligence slice (extended PRD) is live in production on a $1/day cap and producing its first actionable candidates; a Marketplace view lists every demand and supply record on its own, with off-network deal tracking (2026-10-12); eBay ingestion is live (2026-10-12); intel search sources can be added at runtime (2026-10-13); PRD v2 adopted (2026-10-15): P0 stabilization code done, its production steps open, P1–P5 not started (`docs/Opportunity_OS_PRD_v2_Implementation_Plan.md`); Phase 5 not started. Phase 3 rails: real Stripe test-mode + Circle/Base Sepolia; `chain` family still a local reference.
**Last updated:** 2026-10-15
**HEAD:** `b1805a6` (application audit; before it `a85ee1f` cheaper intel search and model options, `b64c312` buyer and seller details, `a47138e` intel search sources added at runtime; `900aa35` off-network counterparty on a listing, `18abada` marketplace listing, `485630d` eBay Marketplace Account Deletion endpoint, `1c197db` intel source and reason-code changes). Session narratives: `docs/SESSION_HANDOFF_2026-10-06.md` (auth → test isolation → workers → AIOOS) and `docs/SESSION_HANDOFF.md` (2026-09-27 Phase 4 work).
**Purpose:** Living memory of *what actually exists in the codebase* and *what is next*. This supersedes the original concept-capture memory (`AI_Opportunity_Operating_System_Project_Memory.md`) for engineering purposes. Requirements live in `Opportunity_OS_TECHNICAL_REQUIREMENTS.md`; rationale lives in `docs/adr/`.

---

## 1. What this is

A model-agnostic, demand-first economic coordination platform that continuously discovers lawful unmet demand and underutilized supply, converts them into structured economic objects, matches them, scores economics + risk deterministically, and presents actionable opportunities to a human operator. It is reframing from a "marketplace aggregator" into a **transaction-discovery network + transaction operating system**: opportunities can arise from *any* signal channel (even by connecting two independent facts with no listing), and every completed deal feeds a learning loop.

Human control is preserved over outbound negotiation, binding commitments, purchases, and movement of money. Fiat and blockchain settlement are native architectural capabilities from day one behind one abstraction.

Internal spine:
`Signals → (Entities/Graph) → Supply → Demand → Matches → Opportunities → Negotiations → Transactions → Settlement → Outcomes`

## 2. Repository shape

Monorepo: pnpm workspaces + Turborepo, TypeScript strict, ESM. Node via `.nvmrc`. `DATABASE_URL`-driven Postgres.

- **20 packages** (`packages/*`): `contracts`, `config`, `ids`-in-contracts, `domain`, `audit`, `auth`, `risk`, `scoring`, `demand`, `discovery`, `connectors-sdk`, `verifiers-sdk`, `negotiation`, `escrow`, `settlement`, `chain`, `llm-gateway`, `observability`, `db`, `ui`, `intel` (AIOOS pipeline, 2026-10-03).
- **9 apps** (`apps/*`): `api` (NestJS/Fastify), `web` (Next.js), `worker-outbox`, `worker-connectors`, `worker-lifecycle`, `worker-temporal`, `worker-notifications`, `worker-agents`, `worker-intel`. Deployed on Railway: `api`, `web`, and cron jobs `worker-lifecycle`/`worker-connectors` (every 15 min) and `worker-intel` (every 6 h).
- **29 SQL migrations** (`packages/db/migrations/0001`–`0029`), forward-only idempotent runner. 0017 asset transfers, 0018 mission sharing/steering, 0019 intel (`intel_runs`, `intel_sources`, `intel_leads`, `intel_candidates`), 0020 `offnetwork_matches`, 0021 `intel_query_sources`, 0022 row level security on every remaining table, 0023 `supply.listing_url` + `supply.seller_json`, 0024 drops the 0002 mission insert/update policies (missions read-only over Supabase REST), 0025 the source registry (`intel_query_sources` renamed to `source_registry` plus FR-01 fields, `source_policy_reviews`, `source_runs`, built-in venues and connectors seeded, a temporary `intel_query_sources` compatibility view), 0026 supply and demand intelligence (lead fields, `demand_hypotheses`, run lane; drops the compatibility view), 0027 `opportunity_evidence` and `opportunity_economics_versions`, 0028 `intel_candidates.outcome_note`, 0029 `crm_links` and `crm_webhook_events` (Pipedrive). **A migration that adds a table must enable row level security on it** (`tests/e2e/rls-coverage.test.ts` fails otherwise). **Production migrations are not run on deploy**: apply them to the Supabase database before pushing code that needs them (`DATABASE_URL=<prod> pnpm db:migrate`, or paste the file into the Supabase SQL editor and insert its name into `schema_migrations`).
- **40 ADRs** (`docs/adr/ADR-001`–`040`). ADR-040: Pipedrive as the CRM for elevated deals (outside PRD v2). ADR-039: delivered-cost deal economics and captured evidence. ADR-037: one source registry with a permission-policy gate. ADR-038: independent supply and demand intelligence. ADR-033 adopts PRD v2 in gated phases with the API as the only binding authority; ADR-034 (proposed) designs bounded delegation grants; ADR-035 records the AIOOS intel decisions; ADR-036 the P0 stabilization.
- **CI**: GitHub Actions — typecheck + unit/integration (vitest) + a Postgres job running migrations (incl. idempotency) + a pgvector job.

### Package roles
| Package | Owns |
|---|---|
| `contracts` | Zod schemas + types for every entity, event, command, connector, escrow condition. Single source of truth. |
| `config` | Validated env → namespaced `AppConfig` (`getConfig()`). |
| `domain` | State machines (`SETTLEMENT_TRANSITIONS`, `TRANSACTION_TRANSITIONS`, `OPPORTUNITY_TRANSITIONS`), `assertTransition`, material-term change detection. |
| `audit` | Hash-chained audit (`AuditChain`, `hashEvent`, `verifyChain`), `hashProposalTerms`, `hashReleaseTerms`, canonical JSON + sha256. |
| `auth` | RBAC permissions + `authorize` (token-gated high-impact actions); HMAC approval tokens (`mint`/`verifyApprovalToken`). |
| `risk` | Category gate, spend limits, prompt-injection detection, anti-gaming assessment. |
| `scoring` | Deterministic versioned opportunity scoring + economics + matching (`matchDemandToSupply`). |
| `demand` | Natural-language demand parser (LLM + heuristic fallback) → `DemandSpecification`. |
| `discovery` | Discovery/synthesis pipeline, entity resolution, market graph, embeddings, graph-derived deals. |
| `connectors-sdk` | `SourceConnector` interface, registry, fixtures, normalization, HTTP-API + crawl adapters, automation-permission gate. |
| `verifiers-sdk` | `EvidenceVerifier` interface + registry; local attestation + deterministic e-signature reference verifiers. |
| `negotiation` | LLM negotiation drafting (deterministic template fallback), feeds market-graph comparables into the draft. |
| `escrow` | Deterministic condition evaluator (AND/OR predicate tree) + release-policy decision engine. |
| `settlement` | Rail-neutral `SettlementService` + `SettlementRail` interface + Stripe fiat rail + stablecoin rail. |
| `chain` | `ProgrammableSettlementAdapter` (local/testnet reference), on-chain hash/anchor helpers. |
| `llm-gateway` | Provider-routed LLM + embedding gateway (echo default; OpenAI/Voyage), cost telemetry. |
| `observability` | Structured logger. |
| `db` | Kysely schema + pool + transactional outbox + all repositories + migration runner. |
| `ui` | Shared web UI primitives. |

### App roles
| App | Role | State |
|---|---|---|
| `api` | NestJS/Fastify REST + OpenAPI. Modules: health, missions, opportunities, approvals, transactions, settlement, signals, entities, public, webhooks, search, intel, marketplace. | Built |
| `web` | Next.js operator/user UI. Pages: home, missions/[id], opportunities, opportunities/[id], approvals, transactions/[id], payments, archive, settings, queue, marketplace. | Scaffolded, all 9 required screens present plus queue and marketplace |
| `worker-outbox` | Transactional-outbox relay (log + Redis publishers). | Built |
| `worker-connectors` | Risk-gated ingestion loop across registered connectors. | Built (fixture + adapter connectors) |
| `worker-lifecycle` | Periodic refresh sweep: discovery + synthesis + entity resolution + graph edges + graph deals. | Built |
| `worker-temporal` | Durable workflows (mission discovery, opportunity execution / approval-wait, settlement milestone timer). | Built (verified against time-skipping test server); all three now started from `apps/api` as opt-in durable paths |
| `worker-notifications` | Approval delivery loop (Telegram/email/log), marks notified. | Built |
| `worker-agents` | Agent runtime host. | Stub / minimal (not deployed) |

## 3. Data model (22 tables)

`users`, `missions`, `mission_versions`, `demands`, `supply`, `matches`, `opportunities`, `counterparties`, `approvals`, `negotiations`, `transactions`, `settlement_plans`, `settlement_milestones`, `evidence`, `audit_events`, `outbox`, `signals`, `outcomes`, `entities`, `entity_members`, `price_observations`, `graph_edges`.

Migrations:
- `0001_init` — 16 core tables (§6 domain), outbox (§10), hash-chained audit (§21).
- `0002_rls` — Row-Level Security with a guarded `auth.uid()` shim (runs on plain Postgres and Supabase).
- `0003_ingestion_upserts` — idempotent upsert unique indexes for discover→match→score.
- `0004_approval_notifications` — `approvals.notified_at`.
- `0005_signals_outcomes` — `signals` + `outcomes` (multi-channel intake + learning loop).
- `0006_market_graph` — `entities`, `entity_members`, `price_observations`, `graph_edges`.
- `0007_entity_embeddings` — `entities.embedding` (jsonb).
- `0008_graph_opportunities` — opportunities gain `kind`, nullable `match_id`, `dedupe_key`, `source_json`.
- `0009_escrow` — `evidence` becomes append-only hash-chained ledger (verifier, trust_tier, predicate_type, prev/evidence_hash).
- `0010_settlement_provider_ref` — `settlement_plans.provider_ref` (rail contract/intent reference).
- `0011_settlement_dispute_refund` — `disputed_at`/`frozen_at`/`refunded_at` on plans, `disputed_at`/`refunded_at`/`external_refund_ref` on milestones, milestone status check widened to include `'refunded'`.
- `0012_milestone_release_windows` — `optimistic_after_at`/`deadman_at` on `settlement_milestones` (ST-13).
- `0013_dispute_resolution` — `pre_dispute_status`/`pre_freeze_status` on `settlement_plans`, `pre_dispute_status` on `settlement_milestones`.
- `0014_milestone_recipients` — `recipients_json` on `settlement_milestones` (ST-12).
- `0015_mission_durable_discovery` — `temporal_workflow_id` on `missions`.
- `0016_milestone_provider_ref` — `provider_ref` on `settlement_milestones` (per-milestone rail reference for rails that can't phase-capture one plan-level reference).

## 4. Event model

41 canonical versioned event names in `EVENT_NAMES` (`contracts/events.ts`), all delivered through the **transactional outbox** so DB state and event publication cannot diverge. Idempotency key per event. Covers mission/demand/supply/match/opportunity/approval/negotiation/transaction/settlement/fulfillment/risk/audit/signal/outcome lifecycles.

## 5. What is built (by phase)

### Phase 0 — Foundation ✅
Monorepo, CI, typed config, Postgres/Supabase-portable, migrations + runner, domain contracts, hash-chained audit, Redis (outbox relay), structured observability, RLS.

### Phase 1 — Economic Nervous System ✅
- Mission CRUD + versioning; NL demand parser (LLM + heuristic) → `DemandSpecification`.
- Connector SDK + fixtures + real adapter shapes (HTTP-API + crawl), risk-gated ingestion.
- Supply/demand persistence, deterministic matching, versioned deterministic scoring + economics.
- Cross-source synthesis: matches every open demand against all supply regardless of source → opportunities with no listing.
- Signals intake (`/signals`, multi-channel) projected into supply/demand; Outcomes (learning-loop record).
- Entity resolution + market graph (canonical dedupe, comparables, price history, `SUBSTITUTE_OF`/`ARBITRAGE`/`BUNDLE_AVAILABLE` edges); entity embeddings + pgvector backend (jsonb default, pgvector opt-in via `EMBEDDING_BACKEND`).
- Graph-derived opportunities: arbitrage/bundle edges become first-class deals on the operator feed.
- Lifecycle worker drives periodic refresh; opportunities enter the DB, match, score, refresh, and appear without manual hunting. **Phase 1 exit criterion met.**

**Real connector, 2026-09-04**: `worker-connectors/main.ts` had only ever
registered the two fixture connectors — `makeHttpApiConnector`/
`makeCrawlConnector` (the real adapter shapes noted above) existed but were
never instantiated by any app, so no real supply/demand data actually
entered the system. First real source now wired: `makeEbayConnector`
(`packages/connectors-sdk/src/ebay.ts`), the eBay Browse API — official
OAuth2 client-credentials app token, `automation: "official_api"` (§17/
ADR-014), gated on `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` (absent = fixtures
only, same keyless-dev pattern as Stripe/Circle). `HttpConnectorConfig.
buildRequest` was generalized to allow an async return so the connector can
fetch/cache its OAuth token before building the search request — a change
any future OAuth-based source (e.g. Etsy) will also need, not an eBay-only
hack.
Known limitation, not yet fixed: eBay's Browse API rejects a blank query,
unlike the fixture connectors' "return everything" shape, so it can't just
join the existing blank-query sweep — it runs as a second, separate
`ingestConnectors` call each cycle against a single static
`EBAY_SEED_QUERY` (default `"electronics"`). The real fix is querying by
live demand descriptions instead of a static seed term — `packages/
discovery/src/pipeline.ts` already calls connectors with a real `input.
query` derived from demand, so that's the pattern to extend to the periodic
worker sweep, not a new mechanism.

**Second real connector + production ingestion, 2026-10-03**: `makeReverbConnector` (`packages/connectors-sdk/src/reverb.ts`) — Reverb public listings API (music gear), `official_api`, keyless (optional `REVERB_API_TOKEN` for rate limits), opt-in via `REVERB_ENABLED=true`. Live-verified: 25/25 listings for "fender stratocaster" pass the risk gate. Three fixes this needed, all live in production now:
- **Category mapping** (`canonicalCategory`, `connectors-sdk/src/category.ts`): the risk gate and matcher only know canonical categories (`electronics`, `furniture`, …), but marketplaces send their own labels ("Monitors", "Electric Guitars / Solid Body"), so the gate dropped **every** real listing — eBay included; it never surfaced because eBay was never configured. eBay now maps labels by keyword; Reverb maps everything to new canonical `musical_instruments` (allowed in `risk.CATEGORY_POLICY`; demand parser keywords added: guitar, amp, drums, …). Unmapped labels pass through unchanged and are still dropped (fail closed).
- **Static seed query → live demand**: `worker-connectors` now searches query-driven connectors (eBay, Reverb) once per active mission, using `searchQueryFromDescription` (`apps/worker-connectors/src/queries.ts`: drops filler/prices/timing, ≤5 terms, ≤10 queries/cycle, sequential), falling back to `CONNECTOR_SEED_QUERY` (→ `EBAY_SEED_QUERY`). A failing source or DB blip is logged, not fatal to the worker.
- **No fake data in production**: fixture connectors (static fake listings) now register only when `connectors.fixtures` is on — `FIXTURE_CONNECTORS`, defaulting to on outside production and off when `NODE_ENV=production` — in both `worker-connectors` and the discovery pipeline (`packages/discovery` now depends on `config`).

**Workers on Railway, 2026-10-03** (cost-minimised): `worker-lifecycle` and `worker-connectors` (`REVERB_ENABLED=true`) run as Railway **cron services** every 15 minutes (`*/15 * * * *`) with `--once` — one cycle, close the DB pool, exit non-zero on failure — so they bill only while running (~$0.10/month each vs ~$2/month always-on). Built from `main` (Railpack, `buildCommand: true`, `pnpm --filter @opportunity-os/<worker> start -- --once`), same region as `api`; `DATABASE_URL`/`RAILPACK_NODE_VERSION` reference `api`'s. Deliberately **not** deployed yet: `worker-outbox` (log publisher only — no event consumers exist; the timeline reads the outbox table directly, so nothing depends on the relay), `worker-notifications` (no Telegram/SMTP configured in prod; would only log), `worker-temporal` (needs a Temporal server; the durable paths are opt-in and best-effort), `worker-agents` (stub). Add notifications back when a channel is configured (a 5-minute cron is the cheap option). eBay ran off until 2026-10-12 (below).

**eBay ingestion live, 2026-10-12**: `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` (production keyset) set on `worker-connectors` and `api`. First real run against the eBay API: `ebay-browse` fetched 25, kept 25, alongside Reverb 25/25 (`supplyPersisted=50`), no errors. That run used the fallback seed query `electronics` because no active mission supplied a term — set `CONNECTOR_SEED_QUERY` or keep a mission active for relevant listings.

**eBay Marketplace Account Deletion endpoint, 2026-10-11** (`485630d`): eBay requires every production keyset to register one or the keyset is disabled, so this is the gate to turning the eBay connector on. `GET`/`POST /v1/webhooks/ebay/account-deletion` (`apps/api/src/webhooks/`, crypto in `apps/api/src/common/webhook-signature.ts`):
- **Challenge (GET)**: returns `{"challengeResponse": sha256(challenge_code + EBAY_VERIFICATION_TOKEN + endpoint)}`. The endpoint is rebuilt as `PUBLIC_API_BASE_URL` + the path, so that variable must match the URL entered in the eBay developer portal byte-for-byte (same fragility as the Twilio signature).
- **Notification (POST)**: verifies `x-ebay-signature` (base64 JSON `{alg, kid, signature, digest}`; ECDSA over the raw body; public key fetched by `kid` from the Notification API with an app token and cached), logs the `notificationId` (never the username) and acknowledges with 201. **Nothing is deleted, because nothing is stored**: the Browse connector keeps item id, title, description, category, price and URL only. Revisit the day a connector persists eBay seller or buyer identifiers.
- **Without `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` on `api`** the public key cannot be fetched, so the notification is acknowledged unverified with a warning — deliberate: it changes no state, and an unacknowledged endpoint gets the keyset marked non-compliant. That was the state in production on 2026-10-11 (an unsigned POST returned 201); since the keys were set on `api` on 2026-10-12 an unsigned POST returns 401.
- `makeEbayAppToken` was extracted from `makeEbayConnector` so the connector and the webhook share one OAuth client-credentials path.
- **Production**: `EBAY_VERIFICATION_TOKEN` and `PUBLIC_API_BASE_URL` (`https://api-production-eb9a.up.railway.app`) set on `api` and the endpoint entered in the eBay portal by the user, 2026-10-11; the live challenge returns 200 with a 64-hex response.
- **Unverified**: signature verification is tested with a locally generated EC keypair only, not a real eBay notification; the challenge hash was not independently recomputed against the production token.

### Phase 2 — Human-Controlled Execution ✅
- LLM negotiation drafting with deterministic template fallback (always non-binding; never auto-sends). Feeds market-graph comparables into the draft.
- Approval service: request → mint HMAC approval token (bound to action + payload hash + expiry) → decision (approve/reject/modify/expire) → audit + events.
- Approval-gated transaction proposal: `POST /transactions/propose` requires an approval token that cryptographically matches the exact action + payload; records an audit-backed execution event; proposer ≠ approver (separation of duties).
- Notifications worker: real delivery loop (Telegram/email/log), marks notified once.
- Temporal: durable Opportunity Execution Workflow requests a human gate, waits for the approval signal (bounded timeout), executes the gated proposal on approve; reject/timeout do nothing. Verified end-to-end against the time-skipping test server with real activities + Postgres.

### Phase 3 — Native Money Rails ✅ (real fiat rail on Stripe test mode + real stablecoin rail on Circle/Base Sepolia; on-chain `chain` family still simulated)
Built:
- Rail-neutral settlement abstraction (`SettlementService` + `SettlementRail`), Stripe fiat rail (test/simulated), stablecoin rail, programmable-chain adapter (local/testnet reference).
- **Escrow condition/release engine** (ADR-029): versioned AND/OR predicate DSL (`shipment_delivered`, `document_signed`, `gps_within_geofence`, `sensor_threshold`, `time_elapsed`, `milestone_attested`, `oracle_true`); pure `evaluateCondition` is the only authority for `MILESTONE_PENDING → MILESTONE_VERIFIED`; `decideRelease` policy (dispute→hold, deadman→auto_refund, auto below threshold, human approval above, optimistic window).
- **Verifier adapters** (`verifiers-sdk`): pluggable `EvidenceVerifier`; keyless local attestation + deterministic e-signature reference verifiers.
- **Evidence ledger**: `evidence` table is append-only + hash-chained per entity; `verifyEvidenceChain` detects tampering.
- **Settlement repos + API**: fund plan, add milestone, submit evidence (verify→ledger→evaluate→verify milestone), release (engine decides auto vs token-gated). Settles the transaction once all milestones release; every hop guarded by the state machine + audit chain.
- **Rail execution** (ADR-030): release actually moves funds — authorize (`prepare`) at fund, capture/settle (`execute`) at release, rail selected by `plan.rail_family`, `provider_ref` + `external_transaction_ref` persisted. `SettlementService.execute` refuses an empty approval-token hash.
- **Refund/dispute execution** (ADR-031, migration `0011`): `SettlementStatus` gains a terminal `REFUNDED`; `SETTLEMENT_TRANSITIONS` reaches it from any funds-held state. New db repo fns `disputeMilestone`/`freezeSettlementPlan`/`refundMilestone` (audit + outbox events `settlement.disputed.v1`/`settlement.frozen.v1`/`settlement.refunded.v1`); new endpoints `POST /settlement/milestones/:id/dispute`, `POST /settlement/plans/:id/freeze` (permission `settlement:dispute`, no token — they block money, don't move it), `POST /settlement/milestones/:id/refund` (permission `settlement:release` + approval token bound via new `hashRefundTerms`, a distinct action from `hashReleaseTerms`). `release()` now reads the plan's real DISPUTED/FROZEN state into `decideRelease` instead of a hardcoded `disputed: false`, and its `auto_refund` branch calls the rail's `refund()` (new optional `dispute?`/`freeze?` on `SettlementRail` too) instead of throwing.
- **Persisted release windows + durable timer workflow** (ST-13, migration `0012`): `settlement_milestones` gains `optimistic_after_at`/`deadman_at`; `POST /settlement/plans/:planId/milestones` sets them at creation (previously milestones could only be created by calling the `addMilestone` repo fn directly from tests — no API existed). `worker-temporal` gains `settlementMilestoneTimerWorkflow` + `checkMilestoneTimerActivity`: a poll-loop that sleeps to the next window, re-reads real milestone/plan state, and calls the same pure `decideRelease` — on `auto_refund` it executes the rail refund + `refundMilestone` with no human token (mirrors `release()`'s own auto_refund branch); on `auto_release` for a still-unverified milestone it treats the elapsed optimistic window as verification (`verifyMilestone`) before executing the normal rail release + `releaseMilestone`; a disputed plan or an above-threshold `require_approval` decision is reported "held" and the workflow stops (§13.5 — no self-authorized money). Verified via `scripts/verify-settlement-timer-workflow.ts` against the Temporal time-skipping test server. Wired into live traffic: `POST /settlement/plans/:planId/milestones` starts the workflow (best-effort — `apps/api/src/settlement/temporal.ts`, a local `@temporalio/client` by workflow-type name, not an import of `worker-temporal`'s code, so the app boundary stays clean) whenever `optimisticAfterAt`/`deadmanAt` is set; a Temporal outage only delays the auto window, it never blocks milestone creation, since `SettlementService.release()`/`refund()` still execute synchronously regardless.
- **`release()`'s require_approval-while-unverified fix**: the manual `POST /settlement/milestones/:id/release` used to hardcode `conditionSatisfied: true` and reject any non-`"verified"` milestone outright, silently dropping `decideRelease`'s optimistic/deadman branches for the one endpoint humans actually call. It now accepts a `"pending"` milestone too, feeds it the real `conditionSatisfied`/`optimistic_after_at`/`deadman_at`, and on `require_approval` with a valid above-threshold token calls `verifyMilestone` before executing the normal rail release — the elapsed window plus the human token together stand in for the engine's own verification.
- **Multi-party splits** (ST-12, migration `0014`): `MilestoneRecipient` contract (`address`, `amount` kind/value, optional `counterpartyId`/`externalRef`) + `settlement_milestones.recipients_json`, settable at creation and validated eagerly — `resolveRecipients` (duplicated between `settlement.service.ts` and the timer activity, same convention as the rest of the sync/durable split) requires one amount kind across all recipients and an exact sum match to the milestone's own resolved amount. `ExecutionResult` gained an optional `recipients` breakdown attached by the rail; `StripeFiatRail.execute()` creates real per-recipient `transfers.create` calls (Connect destination-charge model) when not simulated, `StablecoinRail`/`ProgrammableSettlementAdapter` simulate deterministically (the chain adapter's `execute()` already recorded a `"split"` event for recipients — this actually threads them into the returned execution result). `release()` refuses a non-empty split against a rail that doesn't advertise `capabilities().supportsMultiRecipient`, and persists each executed recipient's rail-assigned `externalRef` back onto the milestone via `releaseMilestone`'s new `executedRecipients` input.
- **Dispute/freeze resolution** (migration `0013`): a dispute previously only ever resolved via refund. `disputeMilestone`/`freezeSettlementPlan` now stamp `pre_dispute_status`/`pre_freeze_status` before overwriting the live status; new `resolveDispute`/`unfreezeSettlementPlan` repo fns restore it, riding new reverse edges added to `SETTLEMENT_TRANSITIONS` (`DISPUTED`/`FROZEN` → the specific prior states they're reachable from — not a blanket wildcard, so an illegal restore still throws `InvalidTransitionError`). New endpoints `POST /settlement/milestones/:id/resolve-dispute` + `POST /settlement/plans/:id/unfreeze` (permission `settlement:dispute`, no token — same as dispute/freeze, since these block/unblock rather than move money); new events `settlement.dispute_resolved.v1`/`settlement.unfrozen.v1`.
- **Durable workflows wired into live traffic** (mission discovery + opportunity execution join the settlement timer): `POST /missions/:id/discover-durable` starts `missionDiscoveryWorkflow` for a mission and records its id on `missions.temporal_workflow_id`; `listActiveMissionsForDiscovery` excludes any mission with one set, so `worker-lifecycle`'s own sweep and the durable per-mission workflow never double-drive the same mission — opt-in, so a mission that never calls this endpoint works exactly as before, and a failed start records nothing (mission stays on the lifecycle sweep). Mission `pause`/`resume`/`archive` best-effort forward the matching signal to a running workflow. `POST /opportunities/:id/execute-durable` starts `opportunityExecutionWorkflow` instead of `requestApproval`'s direct `createApproval` call — the workflow's own first activity creates the approval identically, so it surfaces in the normal approvals inbox unchanged; `ApprovalService.decide` best-effort signals the matching workflow (deterministic id `opp-exec:<opportunityId>`) with the decision and, on approve, the freshly minted token, in one signal (an earlier draft signaled twice — once before minting, once after — which would have let the workflow's first `condition()` wake on a tokenless signal; fixed before it shipped). A `WorkflowNotFoundError` from signaling a non-durable approval's non-existent workflow is caught and ignored — the default synchronous path is unaffected.
- **Milestone/release UI** (UI-4): the Payments page was read-only (a table, nothing else) despite the API having fund/dispute/freeze/refund endpoints since ST-11. Added: fund-plan button, freeze/unfreeze with a reason field, a create-milestone form (single-predicate release condition + optional ST-13 windows — a full AND/OR condition-tree builder is left to the API/a later pass), and a per-milestone management panel (evidence ledger view, submit-evidence form, release with an optional approval-token field, dispute, resolve-dispute, refund). Every action is a thin call to its gated endpoint; the UI makes no policy decisions itself. Fixed in passing: the `Evidence` contract was still the pre-migration-0009 shape (missing `verifier`/`trust_tier`/`predicate_type`/hash-chain fields) — the typed API client needed the real shape to render the ledger.

- **Real settlement provider — Stripe test mode** (ST-2/ST-13/API-7): `StripeFiatRail` already had non-simulated code paths (real `paymentIntents.create/capture/retrieve`, `refunds.create`) when `STRIPE_SECRET_KEY` was set — but nothing had ever run them against the live test API, and doing so surfaced two real bugs invisible under simulation (the simulated rail has no memory of prior calls, so it can't fail the way a stateful provider does):
  1. **Multi-capture bug**: a Stripe PaymentIntent can be captured exactly once, but `ensurePrepared` reused one plan-level `provider_ref` across every milestone — a plan's second milestone release would hit a real "already captured" API error. Fixed: a rail that can't phase-capture one reference (`capabilities().supportsMilestones: false` — Stripe) now gets its own reference **per milestone**, prepared lazily on first release/refund for exactly that milestone's amount (new `settlement_milestones.provider_ref`, migration `0016`); `ensurePrepared`/`fund()` are duplicated with this fix in both `apps/api/src/settlement/settlement.service.ts` and the timer activity (existing convention). A rail that CAN phase-capture (stablecoin/chain, `supportsMilestones: true`) is completely unaffected — still one plan-level reference prepared once at fund time.
  2. **Pre-capture refund bug**: `refund()` always called `refunds.create()`, but Stripe can only refund a *captured* charge — a deadman auto-refund on a milestone that was never released (still `requires_capture`) would error. Fixed: `refund()` now checks the intent's status and `cancel()`s an uncaptured hold instead of trying to refund it; the caller (`executeRefund`/the timer activity) also skips calling the rail at all when no reference was ever prepared for that milestone/plan, rather than authorizing a fresh hold just to immediately cancel it.
  3. **Idempotency**: `execute()`/`refund()`/`prepare()` now pass Stripe idempotency keys (`approvalTokenHash` — already a deterministic hash of the exact release terms — for capture/transfers; a deterministic key for refund/prepare) so a Temporal-retried activity (`retry: { maximumAttempts: 3 }`) can't double-capture, double-transfer, or double-refund.
  4. **Webhook verification + reconciliation** (ST-13's "async provider status reconciliation"): `POST /webhooks/stripe` used to verify a re-serialization of the parsed body against a generic HMAC helper — Stripe signs the exact raw bytes, so this always would have failed against a real webhook. `main.ts` now sets `rawBody: true` (Nest+Fastify populates `req.rawBody`); the handler verifies with `Stripe.webhooks.constructEvent` and reconciles `payment_intent.succeeded`/`charge.refunded` (idempotent releases/refunds a `provider_ref`-matched milestone still `pending`) and `payment_intent.payment_failed`/`charge.dispute.created` (disputes it — conservative, reversible, blocks money rather than guessing). A reconciliation conflict (e.g. plan already disputed by another path) is logged and swallowed so Stripe doesn't retry forever.
  5. **Redirect-method rejection**: `paymentIntents.create()` with no explicit `payment_method_types` defaults to the connected account's dashboard-enabled automatic payment methods — several of which (Klarna, Cashapp, etc.) can redirect the customer off-page, so Stripe demands a `return_url` this server-side manual-capture flow has no concept of. Fixed: `prepare()` now pins `payment_method_types: ["card"]` explicitly.

  **Verified against the live Stripe test API** (not simulated, real network calls, `sk_test_...`) by `scripts/verify-stripe-provider.ts` — all 9 checks passed: both milestones of one plan capture their own PaymentIntent independently (findings 1 and 5 together — this is the one that would have failed outright pre-fix, with a real "already captured" error from Stripe on the second milestone), a retried `execute()` with the same idempotency key doesn't double-capture, `refund()` correctly branches to `cancel()` pre-capture vs. a real `Refund` post-capture, and `constructEvent` accepts a correctly-signed payload while rejecting a wrong-secret or tampered one. Not yet reconciled: recipient-level Transfer events (`transfer.reversed`) — those live inside `recipients_json`, not a plain column, so `getMilestoneByProviderRef`'s exact-match lookup doesn't reach them.

- **Real settlement provider — Circle stablecoin (Base Sepolia)**: the user explicitly required a *custodial* model here — Circle's MPC-based Developer-Controlled Wallets holds the platform's keys, not the platform itself, keeping §C-6 ("platform never holds private keys") intact the way a direct ethers/viem hot-wallet integration would not have. `StablecoinRail` (`packages/settlement/src/stablecoin.ts`) gained real `@circle-fin/developer-controlled-wallets` (v10.8.0) code paths alongside the existing simulated fallback, using `initiateDeveloperControlledWalletsClient({apiKey, entitySecret})`; `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID` config added, wired into both rail-composition sites (`apps/api/src/settlement/rails.ts`, the duplicated copy in `worker-temporal/src/activities.ts`).
  - Unlike Stripe's authorize/capture split, there's nothing to prepare ahead of time on-chain — `prepare()` just returns the configured wallet id; the real work is at `execute()` (`createTransaction`, one Circle transfer per ST-12 recipient, USDC token id resolved once via `getWalletTokenBalance` and cached). On-chain transfers always need a **real destination address** — there is no implicit "platform balance" landing zone the way Stripe capture has — so `execute()` throws if no recipient is set, even for a "single payee" release.
  - Circle transfers are **asynchronous by nature** (`INITIATED → CLEARED → QUEUED → SENT → CONFIRMED → COMPLETE`, minutes away) — `execute()` always returns `"pending"`, never a synchronous `"confirmed"`. This surfaced a real, shared bug: `release()`/`checkMilestoneTimerActivity` treated any non-`"failed"` result as fully released immediately, which was mostly invisible for Stripe (cards usually confirm synchronously) but would be *wrong every time* for Circle. Fixed in the shared code both rails go through: a new `markMilestoneReleasePending` repo fn persists the execution reference (`external_transaction_ref`) **without** flipping status to `"released"`; the milestone stays `"verified"` until a webhook confirms it. Benefits Stripe too (its own rare async-capture case was silently mishandled the same way before this).
  - `POST /webhooks/circle` (new): Circle signs notifications asymmetrically (`ECDSA_SHA_256`, not a shared-secret HMAC like Stripe/Telegram) — verifies by fetching + caching the signing public key for the `X-Circle-Key-Id` header via `client.getNotificationSignature(keyId)`, then `crypto.verify("sha256", ...)` over the raw body (DER encoding — Node's default for an EC key, and the common KMS/HSM convention; **unverified against a live Circle account** in this pass). Reconciles by `external_transaction_ref` (not `provider_ref`, which holds the *shared wallet id* here, not a per-transaction reference) — `COMPLETE` finalizes via the real `releaseMilestone`; `FAILED`/`DENIED`/`CANCELLED`/`STUCK` disputes it. The ECDSA verification itself is extracted as a standalone `verifyCircleSignature` function specifically so it's checkable without a live account.
  - `supportsRefund` stays `false` (already true of the pre-existing simulated rail): on-chain has no "reverse this charge" primitive, only "send more USDC somewhere," and no buyer refund address is tracked anywhere in the data model — an honest limitation, not a regression.
  - **Live-verified end to end** (follow-up session, once sandbox credentials existed): registered a real entity secret, created a wallet set + wallet on `BASE-SEPOLIA` (`generateEntitySecret`/`registerEntitySecretCiphertext`/`createWalletSet`/`createWallets`, all scripted — no manual Circle console steps beyond issuing the API key), funded it with testnet USDC via Circle's web faucet (the SDK's own `requestTestnetTokens` API returned `Forbidden` for this sandbox account — a Circle-side account-verification gate, not a bug here), then ran `scripts/verify-circle-provider.ts` for real: **9/9 checks pass**, including a real `StablecoinRail.execute()` call that submitted an actual on-chain transfer, confirmed on Base Sepolia (real `txHash`, real block height), polled through `INITIATED → ... → CONFIRMED → COMPLETE`, with `rail.status()` correctly mapping the completed transaction to `"confirmed"`.
    - **Real bug this caught**: Circle's `idempotencyKey` must be **UUID-shaped** — the original code's `${approvalTokenHash}:${address}` (a valid, unique string, just not UUID-formatted) was rejected outright by the live API with "API parameter invalid," while the identical call with no idempotency key at all succeeded. No amount of type-checking or self-testing catches a runtime API validation quirk like this — only calling the real endpoint did. Fixed with a `deterministicUuid()` helper (SHA-256 of the same seed, reshaped into valid UUIDv4 syntax) so retries still dedupe on the same key — a random UUID per attempt would have silently defeated the whole point of passing one.
    - The Circle API faucet needing an account-level upgrade (see above) is a real, external constraint, not a code gap — funding stayed a one-time manual step (Circle's web faucet) even though transfers themselves are fully automated.
  - **UI gap this surfaced, since closed**: the Payments page's create-milestone form (UI-4, built before this pass) had no recipients field. Fixed same session: an editor (address + a shared split-by-percentage/amount kind, add/remove rows) now lets a milestone get a real payout address through the console, not just the API — required for a stablecoin release to be driven from the UI at all. Smoke-tested in a real browser (Playwright, mocked API response) — renders and adds/removes rows with no console errors.

- **Recipient-level webhook reconciliation** (2026-09-27): `MilestoneRecipient` gained `payoutStatus` (`pending`/`confirmed`/`failed`/`reversed`/`partially_reversed`, null on older rows), stamped at execute time in both `settlement.service.ts` and the worker's timer activity, then refined per recipient by webhooks via `getMilestoneByRecipientRef` (jsonb containment on `recipients_json`) + `setRecipientPayoutStatus` (row-locked so sibling webhooks serialize; audit-chained; never downgrades to `pending`).
  - **Circle** (`reconcileCircleTransaction`): each notification updates its own recipient; the milestone releases only once **every** recipient is `confirmed` (`allRecipientPayoutsConfirmed`). **Real bug fixed**: previously `external_transaction_ref` held only the first recipient's tx id, so that one transfer's `COMPLETE` released the whole split while the others could still fail. Any recipient failing disputes the milestone; a later sibling `COMPLETE` is recorded but can't release it.
  - **Stripe** (`reconcileStripeTransfer`): `transfer.created` backfills `confirmed`; `transfer.reversed` records `reversed`/`partially_reversed` on the recipient + audit chain and logs for operator review — **no state move**, since by then the milestone is released and a SETTLED plan has no legal DISPUTED edge. The Stripe dashboard webhook endpoint must subscribe to `transfer.created`/`transfer.reversed` for this to fire.
  - **Guard added**: `payment_intent.succeeded` no longer auto-releases a split milestone whose recipients have no Transfer id. Transfers are only created by `execute()` when capture confirms synchronously; an async capture made none, and releasing would mark unpaid recipients as paid. **Open gap**: that milestone now stays `verified` with nothing that creates the Transfers — re-calling release replays the cached capture response (same idempotency key), so it needs an explicit "pay out split after late capture" path. Rare (cards capture synchronously), but not handled.
  - Tests: `tests/e2e/webhook-reconciliation.test.ts` (5, live Postgres) + pure-helper unit tests in `webhooks.service.test.ts`.

Remaining (Phase 3):
1. Split payout after an *asynchronous* Stripe capture (see the guard note directly above).
2. Durable milestone-*evidence* waits, as opposed to the release-window waits ST-13 already covers (WF-3 remainder).
3. `executeRefund`'s parallel "pending refund" gap (documented, currently unreachable — no rail refunds asynchronously today).
4. A real rail is not the same as a *production* one (§C-6): going live needs a licensed money-transmitter partnership + an audit for both Stripe and Circle — a business/compliance decision, not a code change. The on-chain/`chain` family remains a local/simulated reference pending its own real provider.

### Phase 4 — Public Demand Marketplace ✅ (agent→user questions outstanding)
All 9 required screens exist as Next.js pages (home/search, missions/[id], opportunities, opportunities/[id], approvals, transactions/[id], payments, archive, settings) with a typed API client; payments is no longer read-only (UI-4, above). Remaining: agent→user questions (the old "Agent questions" placeholder card was replaced by the Steer card — nothing in the system generates agent questions yet).

**Search/Ask + archive (2026-09-27)**: `POST /missions/parse {text}` runs `parseDemand` (LLM, heuristic fallback) and creates nothing; the home page's "Read my request" prefills the form from it and, on create, keeps what the form has no field for (constraints, needed-by, …) with the visible fields winning. Before this the home page always sent its own `demand_spec`, so the parser never ran and budget/timing in the text were ignored despite the hint claiming otherwise. `GET /search?q=` (`apps/api/src/search`, `packages/db` `searchForUser`) searches missions (title/intent) and live opportunities (matched listing) with the same visibility as mission access; LIKE wildcards are literal. Archive page: text filter, "Shared with me" filter, opportunity count + last activity columns, most-recently-active first.

**Sharing (2026-09-27, migration `0018`)**: `mission_shares` (viewer/editor, unique per mission+user; revoke deletes the row, `mission.shared.v1`/`mission.unshared.v1` outbox events are the durable record and show on the mission timeline). `apps/api/src/missions/mission-access.ts` `requireMissionAccess(principal, missionId, "view"|"edit"|"own")` runs on **every** per-mission route on top of the role permission: owner > editor > viewer; staff overrides admin=owner, operator/reviewer/service/agent=read-only; no access returns **404, not 403** (ids can't be probed). Behavior change: before this, any user could read any mission by id and operators could pause/resume any mission. Edit = PATCH/pause/resume/discover-durable/steer/set-aside; own = archive + share management. `GET /missions` now returns owned + shared with `access`, `opportunity_count`, `last_activity_at`. User ids are compared as text in SQL (the dev auth shim doesn't validate `x-user-id`).

**Steering (2026-09-27)**: `POST /missions/:id/steer {exclude_terms, note}` writes a new immutable mission version with each term as a hard `keyword neq <term>` constraint (`EXCLUDE_TERM_FIELD`/`excludedTerms`/`matchesExcludedTerm` in `contracts/demand-spec.ts`), sets matching open (candidate/qualified) opportunities aside with the reason, emits `mission.steered.v1`. `projectMissionDemand` carries `excludeTerms`; `runDiscoveryCycle` skips scoring (still persists the supply) for excluded listings. `POST /opportunities/:id/reject {reason}` (mission edit access; operator permission for graph deals) → status `rejected` + `rejection_reason`/`rejected_by`/`rejected_at`; `GET /missions/:id/rejected`. **Real bug fixed**: both opportunity upserts overwrote `status` on every re-discovery, so a rejected, approved, or executing opportunity went back to candidate/qualified on the next sweep — now only candidate/qualified/expired rows take the fresh status (`rediscoveredStatus`). **Second gap fixed**: a running durable `missionDiscoveryWorkflow` was started with a fixed demand, so constraint edits never reached it; new `demand` signal (`signalMissionDemand`) is sent after PATCH-with-spec and steer.

**Timelines (2026-09-27)**: `GET /transactions/:id/timeline` (was: audit rows whose `entity_id` is the transaction itself — missed everything hanging off it) and new `GET /missions/:id/timeline` (was: 3–4 items synthesized client-side from the mission row) both return `TimelineEntry[]` (`packages/contracts/src/timeline.ts`) from `packages/db/src/repositories/timeline.ts`. Merges, by one source per fact so nothing duplicates: the audit chain (transactions, settlement plans/milestones incl. per-recipient payouts, asset transfers, negotiations, opportunities); the **outbox** for aggregates that write no audit rows (missions — create/edit/pause/resume/archive live *only* there — and approvals, which also have no `created_at` column); the milestone evidence ledger; `mission_versions`; and discovered opportunities. Capped at 500 entries. Shared `apps/web/src/components/EntityTimeline.tsx` renders it newest first with category filter chips + deep links to opportunity/transaction pages. Tests: `tests/e2e/timeline.test.ts` (2, live Postgres); both pages smoke-tested in real Chromium against a mocked API with no console errors. WSL gotcha: `next dev` on `/mnt/c` misses file changes — run it with `WATCHPACK_POLLING=true`.

### AIOOS opportunity intelligence (extended PRD, 2026-10-03)
User-supplied master prompt saved as `docs/Opportunity_OS_AIOOS_Master_Prompt.md`; §31 inspection report + the built vertical slice in `docs/Opportunity_OS_AIOOS_Gap_Analysis.md`. Slice v1 is built: Claude provider in the gateway (first real text model — before this every "LLM" path ran on the echo stub), Brave search abstraction, `packages/intel` pipeline with deterministic verification / why-paid / EV / bucket rules, migration 0019, `worker-intel` cron, `/intel/*` API, `/queue` Action Queue page. Hard daily cap `INTEL_DAILY_BUDGET_USD` (user chose $1). Production needs `ANTHROPIC_API_KEY` + `BRAVE_SEARCH_API_KEY` on `worker-intel` before it does anything.

Known quality issue it supersedes: with no embedding key in production, graph "substitute" edges come from the echo embedding, so `worker-lifecycle` produced 27 arbitrage deals from 25 Reverb listings on 2026-10-03 — mostly noise. The Action Queue's verification and why-paid gates are the intended replacement for treating those as opportunities.

### Marketplace: demand and supply listed on their own (2026-10-12)
Before this, only matched pairs surfaced — opportunities for the mission pipeline, queue candidates for web intelligence. Unmatched records were stored and never shown, and those are the ones an operator with counterparties outside the network can use.

- **Listing** (`18abada`): `listMarketListings` (`packages/db/src/repositories/listings.ts`) merges `intel_leads`, `supply` and `demands` into one `MarketListing` shape, newest first, capped at 500 per table. `matched` means the system found an opposite side: for an intel lead, a non-rejected candidate with a `counter_url` or `service_key` (a candidate row alone is not a pairing — `no_counterparty_found` ones sit in WATCH); for marketplace rows, a `matches` row. A `problem` lead lists on the demand side. Supply rows carry no URL: connectors' `uri` is not persisted. **[since 0023]** supply rows store `listing_url`, and the listing shows it.
- **API**: `GET /v1/marketplace/listings?side=&origin=&unmatched=true` → `{ demand, supply, counts, off_network }`. **Staff-only** (`opportunity:reverify`), because it includes every user's mission demands.
- **Off-network deals** (`900aa35`, migration `0020`): "I have the other side". `offnetwork_matches` holds a polymorphic reference to a listing (origin + row id, no FK; the title is copied), counterparty name/contact/terms/price, and a status (`open`/`contacted`/`agreed`/`won`/`lost`/`dismissed`). `POST /v1/marketplace/listings/:id/off-network` and `POST /v1/marketplace/off-network/:id/status`. A listing with a live deal (not lost/dismissed) stops counting as unmatched; `matched` itself stays the system's finding. **RLS is enabled with no policy** on this table — it holds contact details of people outside the system, and only the API (table owner) reads it.
- **Web**: `/marketplace` — Demand and Supply tables, text/origin filters, "Unmatched only" on by default, per-row "I have the supply"/"I have the buyer" form, a deals table with status changes, CSV export per table (cells starting with `= + - @` are neutralised, since titles come from scraped pages).
- **Limits**: a deal is tracking only — it does not create a transaction, contract or escrow, and is separate from both the intel queue and opportunities. The intel sweep searches demand and problem venues only, so intel supply is near empty by design; supply comes from connectors. Deals write no audit or outbox events (same as the intel tables).
- **Verified**: `tests/e2e/marketplace.test.ts` (3, live Postgres); API error paths by hand; the page driven end to end in headless Edge (open form, submit, status change, filters) against a local API. **Not verified**: the CSV download; the page against production data (needs a signed-in staff account). Migration `0020` was applied by the user in the Supabase SQL editor on 2026-10-12; nothing had queried the table in production when this was written.
- **Unreviewed risk noticed while building**: only `missions`/`mission_versions` (0002), `offnetwork_matches` (0020) and `intel_query_sources` (0021) enable RLS. Whether Supabase's anon key can read the other tables (`users`, `counterparties`, `intel_leads`, …) through its REST API was not checked. **Checked 2026-10-13**: the user's check of the production database found them exposed; migration `0022` enables row level security with no policy on every table the migration role owns in `public` (see §12 item 7).

### Intel search sources added at runtime (2026-10-13)
Before this, the stage-1 venue list lived only in `packages/intel/src/queries.ts`, so every new source needed a deploy. An external agent now submits sources; they are vetted on arrival and join the query pool from the next sweep (`a47138e`, migration `0021`).

- **Storage**: `intel_query_sources` (domain, orientation, topics, status `active`/`paused`/`rejected`, reason; unique per domain + orientation). Distinct from `intel_sources`, which is the yield registry of hosts leads came from. **RLS is enabled with no policy**: rows become paid search queries.
- **Vetting** (`vetSource`, `packages/intel/src/sources.ts`): a source is only ever a `site:` filter on the search provider. It is held when it has no public pages (paid, login or API only), is a documentation host, is a government portal, is already in the built-in pool or covered by a connector, or is a supplier directory. An orientation of "both" lists on each side. Submitted topics are stripped of quotes and search operators; without topics one phrase is derived from the sector.
- **Sweep**: `runIntelCycle` merges active sources into the pool (the built-in pool still runs if they cannot be loaded) and pauses a source once every one of its queries has been searched three times with no lead.
- **API**: `GET`/`POST /v1/intel/sources`, `POST /v1/intel/sources/:id/status`. Submission is open to signed-in staff or to the agent's shared secret (`INTEL_SOURCES_TOKEN`, header `x-intel-sources-token`); without the variable only staff can submit. A resubmitted source keeps its status.
- **Web**: Sources panel on the Action Queue page (`IntelSources.tsx`): JSON import, yield per source, pause/resume.
- **Verified**: `packages/intel/src/sources.test.ts`, `tests/e2e/intel-sources.test.ts` (live Postgres). Migration `0021` was applied by the user in the Supabase SQL editor before the push.

### Opportunity detail: buyer and seller (2026-10-13)
Before this the opportunity page showed economics and scores only; the demand, the supply listing and the match explanation behind it were stored but never returned, and connectors' listing URL, seller and item location were read from the APIs and dropped.

- **Ingest** (migration `0023`): `normalizeObservation` now carries `uri`, `seller` (`{ name, url?, detail? }`), `location` (GeoLocation shape with a display `label`) and `condition`. eBay maps `itemWebUrl`, `seller` (username, feedback) and `itemLocation`; Reverb maps its web link, `shop_name`/shop page and condition (its listing search gives no location). Links from untrusted content are kept only when they parse as http(s) (`safeHttpUrl`). `upsertSupply` stores them in `listing_url`, `seller_json`, `location`, `condition_json`; a later sighting without a detail keeps the stored one. Existing rows fill in as the sweep sees them again.
- **API**: `GET /v1/opportunities/:id` adds `details` (`getOpportunityDetails`, `packages/db/src/repositories/opportunity-details.ts`): `sides` (buyer / seller records with title, summary, price, platform, link, location, seller, condition, needed-by, mission, originating signal) and `match` (sub-scores, rationale, shared terms, category / budget fit). Graph deals list up to 5 listings per side from their entities ("Buy from", "Sell into" — comparable listings, not confirmed buyers; bundles: "Sellers to aggregate"). **Behavior change**: the route now requires mission view access for mission opportunities (404 otherwise), since the detail includes the buyer's mission text. `GET /v1/opportunities` still lists every qualified opportunity to any role with `opportunity:read`.
- **Web**: Buyer and Seller cards and a "Why they matched" card on `/opportunities/[id]`; external links open in a new tab with `noopener noreferrer nofollow`. Marketplace supply rows now link to their listing.
- **Verified**: `tests/e2e/opportunity-details.test.ts` (2, live Postgres), connector tests for eBay/Reverb mapping, `normalize.test.ts` (unsafe links dropped). **Not verified**: the page in a browser; real eBay responses (fields taken from the Browse API's documented `itemSummary`; Reverb fields checked against one live public listing).

### Phase 5 — Learning & Scale ⬜
Outcomes are captured (the learning fuel). Remaining: performance feedback loop, score calibration from outcomes, source-yield optimization, search index (FTS/Typesense), graph analytics (Neo4j/pgvector at scale), increased automation under policy, AWS migration where justified.

## 6. Cross-cutting invariants (do not regress)

- **No self-authorized money** (§13.5): high-impact actions (`transaction:propose`, `negotiation:send`, `settlement:execute`) require a valid, unexpired, hash-matched approval token; `SettlementService.execute` refuses an empty token hash.
- **Approval binds exact terms** (§14): a token is invalid if any material term changes; `hashProposalTerms`/`hashReleaseTerms` are the shared canonical hashes used by API and durable workflow.
- **Untrusted data is never instructions** (§13.2/13.3): connector/signal content is risk-gated for prompt injection; verifiers, not free text, move escrow state.
- **Deterministic scoring/eval** (§12, escrow): the ranking function and condition evaluator are versioned CODE; an LLM may estimate components but never decides.
- **Tamper-evident history** (§21): audit + evidence are append-only hash chains; `verifyChain`/`verifyEvidenceChain` must stay green.
- **Outbox, not dual-write** (§10): DB state and events change in one transaction.
- **Legality gates in `risk`** (§17): permitted automation only; category gate; no prohibited scraping.
- **Platform never holds keys/funds directly** (§19): fiat via licensed partner, on-chain funds live in the contract.

## 6a. Authentication (§22, 2026-10-02)

The API used to trust `x-user-id` / `x-user-role` headers from anyone, including in production. Now:
- `apps/api/src/common/auth.guard.ts` — global `AuthGuard` (`APP_GUARD`) resolves the caller once per request; `@CurrentUser()` throws 401 when there is none. The guard never rejects by itself, so webhooks/health/public intake (which authenticate another way) are unaffected.
- `apps/api/src/common/auth.ts` — `createTokenVerifier`: Supabase access token via the project's JWKS (`SUPABASE_URL`), or HS256 with `SUPABASE_JWT_SECRET` for legacy projects. Issuer + `authenticated` audience checked; anon/service-role/anonymous tokens refused; algorithm family comes from config, not the token.
- Role is application-owned: read from `users.role`, never from the token. First sign-in provisions the row with `id = sub` (`packages/db` `provisionUser`), role `admin` if the email is in `AUTH_ADMIN_EMAILS`, else `user`. An email already held by another id is refused, not linked. Non-`active` users are rejected.
- `AUTH_DEV_HEADERS=true` re-enables the header shim for local dev; config refuses to load with it when `NODE_ENV=production`. With nothing configured every authenticated route returns 401.
- CORS: `WEB_ORIGINS` (comma list). There was no CORS at all before, so the deployed web app could not call the API from a browser.
- `GET /me` returns id/role/email. Web: `AuthGate` (email + password sign-in/sign-up via `@supabase/supabase-js`) wraps the shell when `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are set (build-time); the API client sends the session token as a Bearer; Settings shows the real identity + sign out.
- Tests: `apps/api/src/common/auth.test.ts` (6). Not yet exercised against a live Supabase sign-in.

## 7. Engineering conventions

- Package resolution: `@opportunity-os/*` → `packages/*/src/index.ts` (tsconfig paths + vitest alias). New packages need `package.json` + `tsconfig.json` and a workspace install.
- jsonb writes: `JSON.stringify` arrays/objects (node-pg treats bare JS arrays as Postgres array literals).
- State transitions: always via `assertTransition` + an audit event in the same DB transaction.
- Tests: vitest; `packages/**`, `apps/**`, `tests/**` included. Live-DB e2e gated by `HAS_DB` (`describe.skipIf(!HAS_DB)`); pgvector e2e is CI-only (skips on plain Postgres).
- **Live-DB tests never use `.env`'s `DATABASE_URL`** (it points at the production Supabase; tests there once left 30 missions + 43 users in prod, deleted 2026-10-03). `tests/setup/test-database.ts` (vitest `setupFiles`) sets `DATABASE_URL` from `TEST_DATABASE_URL`, refuses any non-local host, and blanks it when unset so live-DB suites skip. Run them with `pnpm test:db [vitest args]`: starts `infra/docker/docker-compose.test.yml` (pgvector/pg16 on port 54329, tmpfs), migrates it, runs vitest. `pnpm db:test:down` removes it. CI's migrations job runs the same suite against its service Postgres.
- `scripts/verify-*.ts` still use `DATABASE_URL` directly — run them only with an explicit local `DATABASE_URL=...` prefix.
- Current health (2026-10-15): **suite 252 pass / 1 skip (62 files)** via `pnpm test:db` (with migration `0024`). The skip is `tests/e2e/pgvector.test.ts`, which runs only in the pgvector CI job.
- **Dev machine (WSL), 2026-10-12**: work from a clone on the WSL filesystem (`~/soko`), not the OneDrive copy — there OneDrive leaves files cloud-only (`EIO` on read from WSL), `pnpm install` fails with `EACCES`, and `git status` takes minutes. Docker Engine is installed in WSL (`docker.io`, `docker-compose-v2`); `corepack enable` provides `pnpm`. Set a repo-local git identity before committing: WSL has no global one and git falls back to `root@<host>`. The root `pnpm typecheck` excludes `apps/web` — run `pnpm --filter ./apps/web typecheck` as well.

## 8. Configuration surface (env)

`NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `SUPABASE_*` (incl. `SUPABASE_JWT_SECRET`), `AUTH_DEV_HEADERS`, `AUTH_ADMIN_EMAILS`, `WEB_ORIGINS`, `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` (web), `REDIS_URL`, `TEMPORAL_*`, `LLM_DEFAULT_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`/`EMBEDDING_BACKEND`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, `DEFAULT_STABLECOIN_NETWORK`, `CHAIN_RPC_URL`, `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID`, `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`/`EBAY_VERIFICATION_TOKEN`, `PUBLIC_API_BASE_URL`, `TELEGRAM_*`/`EMAIL_FROM`/`SMTP_URL`, `APPROVAL_TOKEN_SECRET`, `AUDIT_ANCHOR_ENABLED`, `APPROVAL_TIMEOUT_MINUTES`, `MISSION_REFRESH_INTERVAL_MINUTES`, `SUPPLY_STALE_MINUTES`, `SETTLEMENT_AUTO_RELEASE_THRESHOLD_MINOR`. All validated in `config`; safe defaults let dev/CI run keyless.

## 9. ADR index

001 TS monorepo · 002 Next.js FE · 003 NestJS/Fastify · 004 modular-first · 005 Postgres/Supabase SoR · 006 Temporal durable workflows · 007 transactional outbox · 008 central LLM gateway · 009 policy-enforced human approval · 010 rail-neutral settlement · 011 blockchain for settlement proofs only · 012 hash-chained audit · 013 Railway-first/AWS-portable · 014 permitted/authorized sources only · 015 deterministic final scoring · 016 V1 decision-packet defaults · 017 lifecycle worker drives V1 discovery · 018 demand parser LLM+heuristic · 019 approval tokens + synchronous execution · 020 LLM negotiation drafting · 021 durable approval-wait workflow · 022 signals→outcomes transaction-discovery network · 023 market graph + entity resolution · 024 embeddings + graph edges · 025 embedding provider · 026 pgvector backend · 027 graph-derived opportunities · 028 risk-gated channel adapters · 029 escrow condition/release engine · 030 rail execution · 031 refund/dispute execution · 032 multi-channel messaging + negotiation:send execution.

033 PRD v2 adoption and deployable boundaries · 034 bounded delegation grants (proposed) · 035 opportunity intelligence · 036 P0 stabilization · 037 source registry · 038 supply and demand intelligence · 039 deal economics and evidence · 040 Pipedrive CRM.

No new ADR filed for the ST-13 timer workflow — it applies ADR-006 (Temporal) and ADR-029's release engine to real timestamps rather than introducing a new decision.

## 10. Crypto-asset & marketplace expansion (open backlog)

Not a phase, not sequenced — an accepted-risk growth area we add to as ideas
show up, distinct from §5's ordered roadmap. Scope: transacting asset
*classes* beyond currency (an NFT, a DeFi position, a data-feed subscription,
a synthetic position), as opposed to §19's settlement rails, which move
currency to pay for any of the above. Decision on record: categories are
**not** hard-blocked pending regulation — `risk.CATEGORY_POLICY` allows
`nft`/`defi_position`/`data_feed_subscription`/`synthetic_position` today;
tighten per-category only when a specific jurisdiction's rule requires it.

Shipped so far (reference-tier, mirrors where `chain`'s settlement rail
started before Circle):
- `contracts`: `AssetKind`, `AssetDescriptor` (chain-agnostic locator),
  `AssetTransferPlan`, `AssetTransferStatus`.
- `settlement`: `AssetTransferRail` / `AssetTransferService` — a sibling
  abstraction to `SettlementRail`, not a method on it, because a transfer
  moves one specific object/position, not a fungible amount.
- `chain`: `ProgrammableAssetTransferAdapter` — in-memory reference rail
  (prepare/execute/status/verifyOwnership, plus dispute/freeze/reclaim for
  escrow clawback). No real chain/marketplace wired up yet.
- `settlement`: `CircleNftRail` (`nft.ts`) — first real (non-in-memory)
  `AssetTransferRail`, prototype tier. Reuses `StablecoinRail`'s Circle
  Developer-Controlled Wallets custody rather than a new integration:
  `createTransaction` with `tokenAddress` + `nftTokenIds` + `amount: ["1"]`
  does an ERC-721 transfer; `getWalletNFTBalance`/`getWallet` back
  `verifyOwnership`, honestly scoped to the platform's own custodial wallet
  only (Circle can't attest an arbitrary external address's holdings).
  Simulated with no Circle config, same duality as `StablecoinRail`. **Not**
  live-verified against a real Circle account yet.

**Shipped, 2026-09-17 — `CircleNftRail` wired into `AssetTransferService` + API**
(closes the "not wired into any service/route" gap above): new
`asset_transfer_plans` table (migration 0017, one row per transfer — not
milestone-based like settlement, since a transfer moves a single
object/position, not a phased amount), `packages/db` repository
(`createAssetTransferPlan`/`setAssetTransferReference`/`recordAssetTransferResult`),
and `apps/api/src/asset-transfers` (module/controller/service/dto/rails.ts,
registered in `AppModule`): `POST /asset-transfers` (create + prepare),
`GET /asset-transfers/:id`, `POST /asset-transfers/:id/execute` (approval-token
gated — new `hashAssetTransferTerms` in `packages/audit`, mirrors
`hashReleaseTerms`'s no-self-authorized-money invariant applied to an asset
instead of currency; new `asset_transfer:plan`/`asset_transfer:execute`
permissions), `POST /asset-transfers/:id/refresh-status` (manual rail poll —
now a fallback: `POST /webhooks/circle` finalizes CircleNftRail transfers by
`external_ref` when the tx id matches no settlement milestone, 2026-09-27;
same pass fixed `recordAssetTransferResult` auditing a real rail's `pending`
submit as `asset_transfer.failed` — now `asset_transfer.submitted`). Rails composed generically by `asset.kind`,
not `nft`-specific anywhere in the app layer — confirmed same session:
**verified the SAME path already carries `defi_position`/
`data_feed_subscription`/`synthetic_position`** through the reference-tier
`ProgrammableAssetTransferAdapter` (already registered alongside
`CircleNftRail`, already advertised all four kinds) — `tests/e2e/asset-transfer.test.ts`
runs create→prepare→execute→persist for all three and asserts
`AssetTransferService.byAssetKind` routes each to the programmable rail, not
`CircleNftRail` (which only advertises `"nft"`). Reference-tier only, no new
code needed for those three kinds — the generic abstraction already covered
them; still no real DeFi/data-feed/synthetic provider (see below).
Dispute/freeze/reclaim persistence deliberately still out of scope:
`CircleNftRail.capabilities().supportsReclaim === false`, so nothing to wire
for the one real rail yet.

Open ideas, unordered, add to freely:
- A real DeFi-position rail (e.g. an Aave/Uniswap LP position) — highest
  exposure of the four (`securities`/Howey-test adjacent); needs its own
  legal read before a live rail, not just a code integration.
- A data-feed-subscription rail — closest to a plain service purchase;
  escrow release can likely reuse the existing `oracle_true` predicate
  (`escrow.ts`) rather than needing new condition types.
- Synthetic-position rail — payout resolves off oracle data; same
  derivative/securities-adjacent exposure as DeFi positions above.
- Custody model for held assets: §19's "platform never holds keys/funds
  directly" invariant needs an explicit answer for *assets* too — does an
  escrowed NFT sit in a platform-controlled contract (like the programmable
  settlement rail's escrow) or a third-party custodian?
- Valuation/appraisal for illiquid or volatile assets mid-escrow — dispute
  and refund math (ST-11-style) assumes a knowable amount; an NFT or DeFi
  position doesn't have one without a price oracle.
- Reclaim enforceability: `reclaim()` only *records* a state change today —
  whether a real rail can actually claw back a transferred asset depends on
  the asset kind and custody model above, not on this interface.
- Tax/reporting surface for NFT/DeFi settlements (cost basis, 1099-DA-style
  reporting) — likely a `packages/audit` or `packages/settlement` concern
  once a real rail exists.

## 11. Multi-channel messaging intake, negotiation & transaction (open backlog)

Unsequenced, add-to-freely — same style as §10. Goal: a person can text,
email, or message Soko (SMS, email, Telegram, WhatsApp, group chats, ...)
what they want to sell/buy, and Soko can respond, negotiate, and carry the
deal to transaction **through that same channel**, not just a web console.

What exists today that this builds on:
- Outbound-only, operator-facing: `deliverApproval`
  (`apps/worker-notifications/src/deliver.ts`) sends a fixed operator's
  Telegram chat / email a one-way approval-link notification. Single
  hardcoded destination (`TELEGRAM_CHAT_ID`/`EMAIL_FROM`), not per-counterparty.
- `POST /signals` (`apps/api/src/signals/`) — multi-channel intake behind an
  authenticated `Principal` (`signal:submit`). `SignalsService.submit` is the
  reusable piece (risk-gates via `detectInjection`, persists, projects into
  supply/demand) — the Telegram prototype below calls it directly, bypassing
  only the HTTP-level auth, the same way `/webhooks/stripe`/`/webhooks/circle`
  bypass it for provider callbacks.
- NL demand parser (`packages/demand`, ADR-018) turns free text into a
  `DemandSpecification` — not yet used by the messaging intake below, which
  currently records inbound text as a raw signal description rather than a
  structured spec (see open ideas).
- `packages/negotiation` (ADR-020) drafts negotiation text but never sends
  it (Phase 2 invariant, §14) — sending a draft *out* through a real channel
  to a real counterparty is new work, not a relaxation of that invariant
  (the human-approval gate on `negotiation:send` still applies).

**Shipped, 2026-09-04 — Telegram inbound prototype** (first channel, per the
"smallest lift" pick above): `POST /webhooks/telegram`
(`apps/api/src/webhooks/webhooks.controller.ts`) already existed for
operator approval-decision callback buttons; extended to also handle plain
`message` updates. `telegramMessageToSignal` (pure, unit-tested,
`webhooks.service.ts`) maps a Telegram text message into a `SignalSubmitBody`
— `channel: "telegram"` (new `SignalChannel` value), `kind: "supply"`
(hardcoded — see open ideas), `source_id: "telegram:<chatId>"`,
`source_reliability: 0.4` (unauthenticated stranger, no track record).
`WebhooksService` now injects `SignalsService` (exported from
`SignalsModule`, imported by `WebhooksModule`) and calls `.submit()`
directly — same untrusted-input handling (`detectInjection`) every other
signal gets, no new bypass. On success or on a rejected (injection-flagged)
message, replies in the *same* Telegram chat via `sendMessage` — the first
per-sender (not single-fixed-operator) outbound dispatch in the codebase.
Same webhook-secret auth as the existing approval-decision path (no new auth
mechanism). No new tests needed for the DI-wired parts (matches the rest of
`webhooks.service.ts`, which has none — verified via live scripts instead);
the pure mapping function is unit-tested.

**Shipped, 2026-09-04 — Twilio SMS inbound** (second channel): `POST
/webhooks/twilio-sms`, same shape as the Telegram receiver but a materially
different signature scheme — Twilio signs the *exact webhook URL* plus every
sorted POST param (`verifyTwilioSignature`,
`apps/api/src/common/webhook-signature.ts`, HMAC-SHA1/base64, unit-tested
against a locally-computed signature), not just the payload the way
Stripe/Circle/Telegram's schemes do. That URL-inclusive scheme means the app
now needs to know its own public URL: new `PUBLIC_API_BASE_URL` config,
prefixed onto the request path (`req.url`) to reconstruct what Twilio
actually called — **fragile if a reverse proxy rewrites scheme/host/path
before this app sees the request**; not exercised against a live Twilio
account in this pass (same "unverified against live account" caveat
`verifyCircleSignature` shipped with).
Also required a real gap-fill: Fastify has no `application/x-www-form-urlencoded`
parser registered by default (only JSON), and Twilio posts inbound SMS
webhooks in that format — `main.ts` now registers one (parses straight to an
object; Twilio's signature covers decoded param values, not raw bytes, so no
raw-buffer capture like Stripe's JSON parser needed here). `twilioSmsToSignal`
(pure, unit-tested) mirrors `telegramMessageToSignal`: `channel: "sms"` (new
`SignalChannel` value), `kind: "supply"`, `source_id: "sms:<From>"`, same
`source_reliability: 0.4`. Reply goes out via Twilio's Messages API
(`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`), same
success/rejection-message pattern as the Telegram reply.

**Shipped, 2026-09-05 — email + WhatsApp channels, and negotiation:send**
(ADR-032 has the full decision record; summary here). Third/fourth inbound
channels: `POST /webhooks/email` (Mailgun inbound routes,
`verifyMailgunSignature` — HMAC-SHA256 over `timestamp + token`, a third
distinct signing scheme alongside Twilio's URL-inclusive HMAC and Circle's
ECDSA) and `GET`/`POST /webhooks/whatsapp` (Meta's verify-token handshake +
`X-Hub-Signature-256`, reusing the existing `verifyHmacSignature` rather
than a new function). `SignalChannel` gains `email`/`whatsapp`.
Outbound sending was pulled out of `WebhooksService` into
`apps/api/src/messaging` — a `MessageChannel` interface + `TelegramChannel`/
`TwilioSmsChannel`/`EmailChannel`/`WhatsAppChannel` + a
`MessageChannelRegistry`, composed in `messaging.module.ts` the same way
`settlement/rails.ts` composes `SettlementService`. All four inbound
handlers now share one `intakeAndAck` helper.
Separately — and this is the bigger piece — **`negotiation:send` is now a
real, callable action**: `POST /negotiations/:id/send`
(`apps/api/src/negotiations/`), gated exactly like `transaction:propose`
(mirrors `TransactionService.propose` line for line): verify the approval
token against `hashNegotiationSendTerms({negotiationId, channel, identity,
text})` (new, `packages/audit`), re-check the approval row, dispatch via
`MessageChannelRegistry`, then persist via `sendNegotiation`
(`packages/db`) — asserts `NEGOTIATION_TRANSITIONS` (new, `packages/domain`:
`draft`/`countered` → `proposed`), appends the returned message id to
`negotiations.outbound_message_ids`, hash-chained audit event, emits the
already-allocated `negotiation.send_requested.v1`. Real gap-fill this
required: `negotiation:send` was a declared `Permission` since ADR-020 but
**granted to no role** — `ROLE_PERMISSIONS` never listed it, so the endpoint
would have 403'd for everyone regardless of token. Now granted to
`operator`/`admin`, same as `settlement:release`/`transaction:propose`.

Open ideas, unordered:
- **Identity resolution**: every channel above carries identity as
  `source_id`/`raw.{chatId,from}` (inbound) or an explicit `{channel,
  identity}` in the request body (negotiation send) — never a resolved
  `Counterparty` (`contracts/entities.ts`). There's still no counterparty
  lookup-or-create by channel identity anywhere in `packages/db`.
- **Inbound replies don't thread to an open negotiation.** This is the
  answer to "does the channel become 2-way once opened": partially. The
  counterparty *can* reply — the webhook is open — but every inbound
  message today creates a brand-new signal (`kind: "supply"`, hardcoded),
  never recognizes "this chat/number already has a `proposed` negotiation"
  and advances it to `countered`/`accepted`/`rejected`. `NEGOTIATION_TRANSITIONS`
  models those edges; nothing drives them from an inbound message yet. Until
  this exists, "2-way" means: counterparty can always speak, but Soko's side
  of the conversation stays one human-approved message at a time, never an
  automatic reply loop.
- **Route through the NL demand parser** instead of a raw signal
  description — today "I want $150 for my monitor" becomes signal free text,
  not a structured price/category/item like `packages/demand` would extract.
- **Supply vs. demand classification**: all four inbound prototypes hardcode
  `kind: "supply"` — a real version should decide from content, or ask.
- **`PUBLIC_API_BASE_URL` correctness in a real deployment** (Twilio) and
  **Mailgun's `multipart/form-data`** (only `x-www-form-urlencoded` is
  registered in `main.ts` today, that's Twilio's content type, not
  Mailgun's — needs `@fastify/multipart` for a real Mailgun route).
- **In-channel transaction actions**: "reply YES to accept" / a one-tap
  approval link sent over SMS — extends `deliverApproval`'s existing
  `actionUrl` pattern, but needs a signed, expiring, channel-deliverable
  token an unauthenticated reply can carry back.
- **Group messaging** is a different shape from 1:1 (multiple participants,
  @mentions/threading, ambiguous "who is negotiating") — its own design
  pass, not bundled into the 1:1 pattern above.
- Abuse/spam surface: an inbound channel open to anyone is a new
  unauthenticated attack surface. `detectInjection` covers prompt injection
  (same as connector content), but there's no rate-limiting or spam
  detection on inbound messages yet.
- None of the four outbound channels (`MessageChannelRegistry`'s
  implementations) has been exercised against a live provider account —
  same "unverified against live account" caveat every provider integration
  here has shipped with pre-verification.

## 12. Immediate next options

As of 2026-10-12 (items 1–5 carried from 2026-10-06; details in `docs/SESSION_HANDOFF_2026-10-06.md`):
1. **Intel signal quality** — the pipeline is mechanically sound (0 errors per run since `2665f39`) but source quality is the bottleneck: 29 leads → 1 VERIFY NEXT, 1 WATCH, 23 REJECTED, cost per actionable ≈ $1.98 over the first 15 runs. Shipped in `1c197db`: federal procurement (sam.gov, *.gov, *.mil) is rejected before the paid assessment; the pool is pruned to 18 queries (liquidation.com, govdeals.com, article-only reddit queries dropped); reason codes fixed (`competitor_offer`, `federal_procurement`, `no_value_path`); upwork, reddit [hiring], tradekey and support.google.com added as demand venues. Details in `docs/Opportunity_OS_AIOOS_Gap_Analysis.md`. Next: re-measure leads → actionable and cost per actionable on runs after `1c197db`; the effect of these changes is not yet measured.
2. **[done in code 2026-10-15] Silence or fix graph arbitrage** — `GRAPH_ARBITRAGE_DEALS=auto` (default) turns cross-entity arbitrage deals off while `EMBEDDING_PROVIDER` is echo and expires the open ones each sweep; bundles unaffected. Set an embedding provider and key to bring them back.
3. **A licensed money-transmitter partnership + audit** (§C-6) — still the gate to real funds on either rail; a business decision.
4. **Phase 5 learning loop** — intel outcomes (contacted/won/lost + reason codes) are now recorded; nothing learns from them yet.
5. **Escrow condition builder in the UI** — the create-milestone form offers a single predicate; the API supports trees.
6. **Connect off-network deals to the transaction path** — a deal in `offnetwork_matches` is tracking only; turning an agreed one into a transaction with terms and escrow is not built.
7. **Confirm migration `0022` closed the exposure in production** — the user's check on 2026-10-13 found the 26 tables without row level security exposed to Supabase's anon and authenticated roles. `0022_rls_all_tables.sql` enables it with no policy; the API and workers connect as the table owner, so they are unaffected. The local suite runs as a superuser, so it does not prove that owner path; `0020` and `0021` already depend on it in production. The user ran `0022` in the Supabase SQL editor on 2026-10-13 and inserted its row into `schema_migrations`. Still to confirm: the exposure query showing row level security on every table, and the app still reading and writing through the API (`/v1/health` returns 200 but does not touch the database). The `0002` mission write bypass is closed by migration `0024` (2026-10-15), tested under the `authenticated` role in `tests/e2e/rls-rest-roles.test.ts`; **apply 0024 to Supabase** (no code depends on it, so order with the deploy does not matter) and confirm both migrations there.
8. **[done 2026-10-15] Verify eBay signatures against a real notification** — after the user sent a portal test notification, `api` logs showed 204 eBay deletion notifications (the test plus live ones) since the 20:56 UTC deploy, each verified (the "acknowledged" line is logged only after `verifyEbaySignature` passes; no unverified-warning or 401 lines) and answered 201.
9. **Set `INTEL_SOURCES_TOKEN` when an outside agent starts posting sources** (added 2026-10-13) — deferred by the user: no outside agent posts to the API yet, and staff can import reports through the Sources panel on `/queue` without it. When needed: generate a value with `openssl rand -hex 32`, set it on the `api` service in Railway (only `api` reads it), and give the same value to the agent, which sends it as the `x-intel-sources-token` header on `POST /v1/intel/sources`. No format is required; the API only compares the two strings. Anyone holding the value can add sources, and active sources become paid search queries (spend stays under `INTEL_DAILY_BUDGET_USD`), so keep it out of git and the agent's prompt text. To rotate, set a new value in Railway and update the agent.
10. **Check the opportunity detail page against production data** (added 2026-10-13) — migration `0023` was applied by the user in the Supabase SQL editor on 2026-10-14, before `fee640e` deployed. Still to check: an opportunity's Buyer/Seller cards after the next connector sweep refills listing links, sellers and locations.
11. **More intel per dollar** (added 2026-10-15). The $1/day cap is not the limit: a run may spend $0.25 (`runAllowanceUsd`) but measured runs spent $0.07–0.18. A run is about 8 × (Brave search $0.005 + Haiku detection $0.002) + 3 × (Sonnet assessment $0.025 + two opposite-side searches $0.01) ≈ $0.16. Detection is the cheapest step, so it gives the most leads per dollar. In order:
    - **Config only** (Railway, `worker-intel`): raise `INTEL_QUERIES_PER_RUN` 8 → 16 (≈ +$0.056/run, still under $0.25); optionally `INTEL_MAX_ASSESSMENTS` 3 → 4 (≈ +$0.035 each). Pacing keeps the cap either way.
    - **Grow the query pool** alongside it: 18 built-in queries plus runtime sources. At 16 queries × 4 runs/day queries repeat, and a repeat still pays Brave but mostly returns already-seen URLs (`knownIntelLeadHashes`), so add sources via the `/queue` Sources panel. Lead quality (29 leads → 1 actionable) matters more than volume.
    - **Opposite-side supply search through the free eBay/Reverb connectors** instead of Brave (`packages/intel/src/run.ts`, the `oppositeQueries` loop) — up to $0.03/run.
    - **[shipped 2026-10-15] Deterministic host pre-filter before detection**: `isNoLeadHost` (`packages/intel/src/rules.ts`) drops reference, news and retail hosts (wikipedia, youtube, amazon, forbes, wordpress.org, …) before the paid detection call; each query's run note counts them as `noLeadHost`.
    - **[shipped 2026-10-15] Budget estimates configurable**: `INTEL_DETECTION_ESTIMATE_USD` (default 0.006) and `INTEL_ASSESSMENT_ESTIMATE_USD` (default 0.04), passed by `worker-intel`. Old hardcoded 0.02 / 0.08 were 3–10× measured cost. `DEFAULT_ESTIMATES` in `run.ts` is now only the fallback for callers that pass none.
    - **Prompt caching** on `DETECTION_SYSTEM`/`ASSESSMENT_SYSTEM` (`packages/llm-gateway/src/anthropic.ts` sends no `cache_control` today). Only pays if each system prompt clears the model's minimum cacheable length — measure token counts first.
    - **Message Batches API for assessments** (50% off) — results arrive asynchronously, so the run would need to pick them up on a later cron.
    - **[shipped 2026-10-15, off by default] Open-weight model provider**: `OpenAiCompatProvider` (`packages/llm-gateway/src/openai-compat.ts`) speaks OpenAI Chat Completions (Together, Groq, DeepSeek, OpenRouter, vLLM), sends the wire schema as `response_format: json_schema` (resends without it on a 400/422), prices replies from `usage` at a configured rate, and preflights with `GET /models`. Per tier: `LLM_FAST_PROVIDER` / `LLM_REASONING_PROVIDER` = `anthropic` (default) or `compat`; `LLM_COMPAT_BASE_URL`, `LLM_COMPAT_API_KEY`, `LLM_COMPAT_{FAST,REASONING}_MODEL`, `LLM_COMPAT_{FAST,REASONING}_PRICE` (`"input,output"` USD/MTok). Config refuses a compat tier without its price, since a model priced at zero would slip past every spend cap. A compat tier falls back to Claude when `ANTHROPIC_API_KEY` is set. Set the vars on `worker-intel` only to scope the change to intel (`api` builds its own gateway). **Not run against a live host.** Next: switch the fast tier (detection) first and compare leads, parse failures and cost per lead against Claude over the same runs before moving assessment; prompt-injection resistance on untrusted pages is the other risk.
    - **[shipped 2026-10-15, off by default] Serper search**: `makeSerperSearch` (`packages/connectors-sdk/src/search.ts`), Google results, `site:` and a `tbs` recency window, at most 10 results per call (larger pages bill more), relative dates ("3 days ago") turned into `publishedAt`. `INTEL_SEARCH_PROVIDER=serper` + `SERPER_API_KEY`; `INTEL_SEARCH_COST_PER_QUERY_USD` overrides the ledger price (default $0.001 for Serper, $0.005 for Brave). **Not run against the live API**; request and response shape follow Serper's documented `/search`. Next: compare result quality on the existing query pool before leaving it on.
12. **PRD v2 (added 2026-10-15)** — `docs/Opportunity_OS_Integrated_PRD_v2.md`, plan and discrepancy list in `docs/Opportunity_OS_PRD_v2_Implementation_Plan.md`. P0 code shipped: migration 0024 (missions read-only over REST), locked outbox relay (`relayOutboxBatch`, `for update skip locked`; fixed concurrent double publish), graph arbitrage suppression (item 2), inbound rate limit (`INBOUND_MESSAGES_PER_HOUR`, default 20, per API process), baseline report `GET /v1/analytics/yield` (staff). Done 2026-10-15: 0024 applied in Supabase by the user; `worker-outbox` added as a Railway cron (`*/5 * * * *`, `start -- --once`, log publisher, same settings as the other workers; service `dc664c69-c9d2-48c0-a582-5b2963bf52c9`); its first run published the 1,374-event backlog. `--once` now drains up to 200 batches per run (`0b53749`). Confirmed in production 2026-10-15 (user, Supabase SQL editor): every public table has row level security; as the `authenticated` role, `users` shows 0 rows and a `missions` insert fails with 42501 "new row violates row-level security policy" — 0022 and 0024 hold, item 7 closed. Still open: verify real webhook signatures for the providers not yet configured (eBay verified 2026-10-15, item 8; Stripe, Circle and the message channels have no secrets set, so they reject everything), read the yield baseline after a week. P1–P5 wait on P0 and on the product decisions in PRD §17.
13. **Intel model calls failing since 2026-10-13 (found 2026-10-16 reading the yield baseline)** — every run since 2026-10-13 recorded `llm_usd = 0` and 0 leads while still paying Brave for 8 searches ($0.16/day): Claude calls failed and the gateway silently fell back to the echo stub, whose text parsed as an empty detection. Preflight (free Models API call) kept passing, which fits an exhausted credit balance or a billing problem rather than a bad key — the user found the Anthropic credit balance exhausted and added credit on 2026-10-16. Fixed in code: with a real provider configured the gateway no longer falls back to echo, and an intel run stops (status `failed`, worker exits 1) on the first provider failure. Baseline through 2026-10-16: 54 runs, $4.83 spent ($2.48 search, $2.35 model), 59 leads (all Brave), 49 assessed, 1 actionable (VERIFY NEXT, 2026-10-06), 18 WATCH (all `no_counterparty_found`), 30 REJECTED (18 `not_credible`, 7 `competitor_offer`, 5 `fraud_risk`), 0 contacted; cost per actionable ≈ $4.83. Opportunities: 170 arbitrage expired (suppression worked), 15 bundles qualified, no mission matches. New web page `/yield` shows this from `GET /v1/analytics/yield`.
14. **Intel discovery is category-agnostic (2026-10-16)** — the user's standing requirement: search for buyers and sellers of *any* product or service. From `1c197db` (2026-10-06) the built-in pool searched only for buyers of the user's own web services (GA4, Shopify, WordPress); the PRD v2 discrepancy list missed this. Now: venues for buying requests (tradekey, go4worldbusiness, ec21, reddit), outsourced-sourcing jobs (upwork), surplus and used equipment (reddit, surplusrecord, machinio) and provider-fixable business problems; detection and assessment prompts frame the user as an independent broker of anything (commission, sourcing, referral fees) who also sells a few services; problem leads now get an opposite-side search for third-party providers. The new venues are unproven: prune them from the per-query yield table after a few days.
15. **P1 slice 1 — source registry (PRD v2 FR-01, ADR-037, built 2026-10-16)** — `source_registry` is the one list of where discovery reads (search venues, eBay/Reverb connectors, later Apify actors). A source runs only when `packages/intel/src/source-policy.ts` (`source-policy-1`) passes: an allowed permission basis for its kind, a robots/terms assessment, an unexpired review. Submissions (`POST /v1/sources`, agent token or staff; `/v1/intel/sources` is an alias) arrive `proposed`; a person with `source:review` (operator/admin, never agents) reviews them on the new `/sources` page (`POST /v1/sources/:id/review`). Each run re-checks the policy (lapsed review = paused), honours per-source `min_interval_minutes` and `max_daily_usd`, writes a `source_runs` row per search, and afterwards pauses venues that fail three times in a row or whose every query has three searches with no lead — built-ins included. `worker-connectors` skips a connector whose row is paused or lapsed and records its runs. Reviews, activations and pauses commit row + audit + outbox (`source.reviewed.v1`, `source.activated.v1`, `source.paused.v1`) together. The migration recorded the built-ins and connectors as reviewed ("migration 0025", due in 180 days). **Rollout: apply 0025 to Supabase before deploying this code** (the code needs the new tables; the compatibility view keeps the currently deployed code working meanwhile), then a later migration drops the `intel_query_sources` view. Deferred to P1 slice 4 (Apify): `source_observations`, `ingestion_quarantine`, actor runs and webhooks.
16. **P1 slice 2 — supply and demand intelligence (PRD v2 FR-02/FR-03, ADR-038, built 2026-10-16)** — leads carry `signal_type`, `evidence_level` (observed/inferred), `supply_terms` (MOQ, price breaks, condition, shipping, expiry, capacity), `title_unverified`, `last_seen_at`/`seen_count`. Inferred demand goes to `demand_hypotheses` (watchlist; revisited every `revisit_days`, confirmed only by an observed lead, expires within 30–90 days) and never to the queue. Inferred signals are capped at WATCH with no outreach; liquidation/distressed stock gets `title_unverified` and stays out of ACT NOW. A budgeted counterpart stage (`INTEL_COUNTERPART_SEARCHES`, default 4) searches suppliers for demand and buyers for supply before assessment and stores the results; `INTEL_HYPOTHESIS_CHECKS` (default 2) revisits per run. `worker-intel --lane=demand|supply` runs each side on its own cron. Events `surplus.detected.v1`, `signal.hypothesis_created.v1`. API `/v1/supply-intelligence`, `/v1/demand-intelligence`; pages Surplus Supply and Emerging Demand. **Rolled out 2026-10-16:** 0026 applied; `worker-intel` runs `--lane=demand` (`0 */6 * * *`); new cron service `worker-intel-supply` (`12a060c3-daef-472d-bf8e-1c68cbf19a75`, `0 3,9,15,21 * * *`, `--lane=supply`, variables referenced from `worker-intel`); `INTEL_RUNS_PER_DAY=8` on both. First runs: demand $0.07 (2 supply leads from demand venues), supply $0.13 (2 liquidation leads flagged title-unverified, 4 buyer searches, all found results, 3 assessed: 2 WATCH, 1 rejected), 4 `surplus.detected.v1` events. `schema_migrations` still needs the 0026 row.
17. **P1 slice 3 — deal economics and evidence (PRD v2 FR-04, ADR-039, built 2026-10-16)** — `packages/scoring/src/deal-economics.ts` (`deal-economics-1`): brokerage / principal / service; model cost lines (labelled) plus stated default assumptions for missing ones; net profit range, probability-adjusted profit, days to cash, tier; gates `negative_net_economics` (rejects) and `capital_exposure` above `DEAL_MAX_CAPITAL_USD` (default $1,000, placeholder for PRD §17; holds at WATCH). Assessment now asks for `mode`, `cost_lines`, `days_to_cash`, `cross_currency`; EV and score use net profit. Every assessment appends to `opportunity_economics_versions` and emits `opportunity.economics_updated.v1` in one transaction; `opportunity_evidence` keeps hashed snapshots of the lead's page and facts, the counterpart used and the contact. Queue ranks by `?rank=profit_first|expected_value|fastest_cash` (gated last); candidate detail returns evidence and economics versions; the Action Queue shows tier, net, P(close), cash-in time, the cost breakdown and evidence. **Rollout:** apply 0027 to Supabase and record it in `schema_migrations` before deploying.
18. **Search switched to Serper (2026-10-16)** — the user added `INTEL_SEARCH_PROVIDER=serper` and `SERPER_API_KEY` on `worker-intel`; `worker-intel-supply` references both. Brave stays configured (set the provider back to `brave` to revert). The hour before the switch, Brave runs found 0 leads and returned 0 results for machinio, surplusrecord, ec21 and go4worldbusiness. First Serper runs: demand 12 leads / 3 assessed (2 VERIFY NEXT), supply 6 leads / 3 assessed (1 VERIFY NEXT, 1 WATCH, 1 rejected) — 3 actionable in two runs against 1 in the 13 days on Brave. Search cost per run fell from about $0.04–0.07 to $0.01; model cost is unchanged at about $0.13. surplusrecord yielded 4 equipment listings and upwork sourcing jobs 7 leads; Shopify community, tradekey and some reddit queries yielded none. The first delivered-cost economics in production: 6 versions, 110 evidence rows; a $250–5,000 net brokerage on surplus GE motors ranked high tier. Compare providers on `/yield` before treating this as settled.
19. **Product owner decisions and follow-ups (2026-10-16)** — PRD §17 answers are recorded in `docs/Opportunity_OS_PRD_v2_Implementation_Plan.md` §6: no jurisdiction, no banned categories (former prohibited categories now `review_required`; ingestion and discovery use `isAdmissible` = known and not prohibited; money still only in `allowed` categories), no capital cap (`DEAL_MAX_CAPITAL_USD` unset = none), email first for outreach, calls recorded and transcribed via RingCentral on a new number (recording must be announced: all-party consent), relationship data archived after 90 days and purged when freshness checks show it stale. Dismissing or losing a candidate now takes a reason and a free-text summary (`outcome_note`, migration 0028). Open-weight models through OpenRouter: `OpenAiCompatProvider` accepts `LLM_COMPAT_EXTRA_BODY` (OpenRouter `provider.require_parameters`, `usage.include`) and uses the host's billed `usage.cost` when reported, so the spend cap counts what was actually charged.
20. **Pipedrive CRM (ADR-040, built 2026-10-16, outside PRD v2)** — "Send to Pipedrive" on Action Queue candidates creates a deal (value = mid net profit, USD, expected close from days to cash, optional `PIPEDRIVE_PIPELINE_ID`/`PIPEDRIVE_STAGE_ID`) plus a note with economics and evidence, once per candidate (`crm_links`). `POST /v1/webhooks/pipedrive` (basic auth `PIPEDRIVE_WEBHOOK_USER`/`PASSWORD`) applies deal events once each and in order: won → candidate won with realized USD, lost → lost with Pipedrive's reason as the note, open → contacted, deleted → link marked. Settings page shows the connection and registers the webhook (`crm:configure`, admin). **Rollout:** apply 0029; set `PIPEDRIVE_COMPANY_DOMAIN`, `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_WEBHOOK_USER`, `PIPEDRIVE_WEBHOOK_PASSWORD` on `api`; deploy; press Register webhook on Settings.
21. **Contacts decision (2026-10-17)** — Opportunity OS is the system of record for contacts (organizations, people, channels, consent); Pipedrive receives person/organization copies when a deal is elevated. Recorded in the PRD plan §6. P2 slice 1 (contacts and consent, with Pipedrive person/org sync) waits for the P1 gate review (ADR-033) and still needs a sending domain/provider decision before outreach (slice 2).
22. **P2 slice 1 — contacts and consent (PRD v2 FR-06, ADR-041, built 2026-10-17)** — started ahead of the P1 gate review at the user's request (exception in ADR-033). `counterparties` is the one party table (people and organizations) with `contact_channels`, append-only `contact_consents`, `contact_suppressions` (hashed opt-outs that outlive a purge), `relationship_memories` (correction = supersede; delete blanks content) and `counterparty_links` (party ↔ lead/candidate/opportunity/off-network, with role); migration 0030. Rules in `packages/relationship` (channel normalization, `mayContact`, retention). API `/v1/relationships` (read `opportunity:reverify`, change `outcome:record`, delete `contact:delete`). `worker-lifecycle` archives parties idle 90 days, freshness-checks archived ones every 30 days (website DNS/HTTP, email MX) and purges only on positive evidence of staleness. Pipedrive: contacts linked to an elevated candidate are copied (organization, then person with emails and phones) and set on the deal; edits update the copy; a deletion request removes it. Pages: Relationships (list, contact detail) and a Contacts section on Action Queue candidates. **Rollout:** apply 0030 to Supabase and record it in `schema_migrations` before deploying (the new code reads the new columns). Outreach (slice 2) still needs the P1 gate review and a sending domain/provider.
23. **P1 slice 4 — Apify ingestion (PRD v2 FR-01, ADR-042, built 2026-10-17)** — Apify actors are `apify_actor` sources: staff register one on `/sources` ("Register an actor": site, actor, fixed build, input, field map, per-run item and cost caps), a review with written permission / provider contract / official API terms plus data-use limits activates it. `worker-connectors` finishes open runs and starts due ones each sweep (policy, interval, one at a time, backoff 15 min doubling to a day, pause after 3 failures; run cost capped by the per-run cap, the source's daily cap and `APIFY_DAILY_BUDGET_USD`, default $1). Apify calls `POST /v1/webhooks/apify` with the `x-apify-webhook-secret` header; the run is then read back from Apify, never trusted from the body. Items are mapped by the field map; new fields, missing id/title, bad prices, unmapped categories and prompt injection go to the Quarantine card (release only for new fields). `source_observations` records every item from every source (eBay/Reverb included) with a canonical URL key: repeats are skipped and the same listing from the official API and an actor merges into one supply row with both sources kept. Migration 0031. **Rollout:** apply 0031 and record it before deploying (worker-connectors writes the new ledger table). To use Apify: set `APIFY_API_TOKEN` and `APIFY_WEBHOOK_SECRET` on `api` and `worker-connectors` (`PUBLIC_API_BASE_URL` on `worker-connectors` too, for the webhook URL), then register and review an actor.
24. **Owner risk acceptance (ADR-043, 2026-10-17)** — the user chose to run `apify~facebook-marketplace-scraper` despite Meta's terms prohibiting automated collection (told of the legal exposure first). Instead of a false "written permission", the review records `owner_risk_acceptance`: Apify actors only, `source:accept_risk` (admin), a required note, valid at most 90 days (`source-policy-2`). Migration 0032. Field maps for marketplace actors leave seller identity unmapped (private individuals).
25. **Apify search plans and category mapping (2026-10-17)** — an actor source can build its search URLs each run (`searchPlan`: URL template with `{city}`/`{query}`, cities, keywords, `fromDemand`, `perRun`, `searchUrlField`): recent observed buyer demand (`intel_leads.item`, 7 days) first, then keywords × cities in rotation; no repeat within 24 h; searches with nothing new 3 times wait a week (migration 0033, `apify_run_searches`). Field maps take `categoryMap` (source category ids/labels → ours) and `dropFields` (removed before anything is stored); unknown category values wait in Quarantine, where "Map and release all" saves the mapping and releases every item with that value. First source: Facebook Marketplace Detroit, on owner risk acceptance (item 24).
26. **Good-deal filter (ADR-044, 2026-10-17)** — `worker-connectors` prices new actor listings against active eBay comparables (title keywords, ≥5 comps, trimmed median); `good_deal` = ≥ `DEAL_MIN_DISCOUNT` (default 30%, halved for listings matching recent buyer demand) becomes a supply lead (≤ `DEAL_LEADS_PER_RUN`, default 10/sweep) that the supply lane assesses (buyer search → economics → Action Queue). Every verdict is kept in `deal_checks` (migration 0034) with its comparables; the actor panel shows the week's counts. Needs the eBay credentials on `worker-connectors`.
27. **P1 gate passed (2026-10-17)** — Serper + open-weight: $0.16 per actionable and 86 leads per $ (baseline Brave + Claude $4.83 and 12), budget held, every source reviewed (Facebook on owner risk acceptance), evidence on 31/48 candidates (pre-slice-3 gap to confirm). Details in the PRD plan §7. Next: P2 slice 2 email outreach, waiting on the owner's sending provider and domain. Follow-ups: log the model per run; check evidence coverage after the slice 3 deploy.
28. **Alibaba RFQs and Craigslist (2026-10-17)** — the owner chose `apt_marble/alibaba-rfq-scraper` (0.0.1; buyer RFQs, a demand source) and `solidcode/craigslist-scraper` (1.0.6; listings plus WANTED posts), both on owner risk acceptance (Craigslist litigates scrapers; Alibaba terms prohibit scraping). Code added: field-map `demandTitlePattern`, `deadline`, `quantityUnit`, `signal`, `categoryFromTitle`; buyer items from actor sources become demand leads each sweep (`DEMAND_LEADS_PER_RUN`, migration 0035), so they get supplier searches and assessment and steer the Facebook/Craigslist search plans.
29. **P2 slice 2 — email outreach (PRD v2 FR-07, ADR-045, built 2026-10-17)** — owner chose a Hostinger mailbox on a separate sending domain (Postmark forbids cold email; Brevo needs opt-in lists). Drafts are written on a contact's Email card or as replies on `/outreach/:id`; only `outreach:send` (operator/admin) approves, quoting the content hash of recipient + subject + body. Gate at approval and at send: email consent for outreach in force, address active, not suppressed. Sent at once by the API when the window and caps allow, else by the `worker-lifecycle` sweep: claimed before SMTP (sent at most once; a stuck `sending` becomes an exception), `OUTREACH_DAILY_CAP` (20/24 h), `OUTREACH_MIN_GAP_HOURS` (72), `OUTREACH_SEND_HOURS` 8-18 America/Detroit weekdays. Footer: name, `OUTREACH_POSTAL_ADDRESS`, unsubscribe link (`/v1/outreach/unsubscribe`, signed token, confirm button) plus one-click headers. IMAP poll files replies by Message-ID or sender; bounce / auto_reply / opt_out / reply, opt-outs and bounces cancel queued mail. Migration 0036. **Rollout:** apply 0036 and record it before deploying; set `OUTREACH_EMAIL_ADDRESS`, `OUTREACH_EMAIL_PASSWORD`, `OUTREACH_FROM_NAME`, `OUTREACH_POSTAL_ADDRESS` on `api` and `worker-lifecycle` (`PUBLIC_API_BASE_URL` on both).
30. **P2 slice 3 — daily brief (ADR-046, built 2026-10-17)** — `worker-lifecycle` builds one brief per local day after `BRIEF_HOUR` (7, `BRIEF_TIMEZONE` else `OUTREACH_TIMEZONE`) from the last 24 hours: actionable candidates, outreach, good deals, sources, spend; every item links to its record and outside source (no model). Emailed from the outreach mailbox when `BRIEF_EMAIL_TO` is set (worker-lifecycle; links use the first `WEB_ORIGINS`). Page `/brief`, API `/v1/briefings`, rebuild with `POST /v1/briefings/generate`. Migration 0037. **Rollout:** apply 0037 and record it before deploying.
31. **Follow-ups and closed archive (ADR-047, built 2026-10-18)** — the Action Queue shows only open candidates; contacted/responded ones age on `/follow-ups` (touches in `candidate_touches`, `status_changed_at` by trigger, cadence `followUpPlan` in relationship: listings days 1/3/6 then cold +4, business 3/7/14 then cold +7, responded next step in 2 days, stalled at 14; snooze). Approved emails about a candidate and replies log touches automatically. Won/lost/dismissed are the Closed tab with Reopen. The daily brief leads with follow-ups due. Migration 0038. **Rollout:** apply 0037 and 0038 and record both before deploying.

