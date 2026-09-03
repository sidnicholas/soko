# Opportunity OS — Project Memory (Implementation State)

**Status:** V1 in active build — Phases 0–3 complete (Phase 3's fiat rail is real Stripe test-mode and the stablecoin rail is real Circle Developer-Controlled Wallets on Base Sepolia; the on-chain/`chain` family remains a local reference), Phases 4–5 partial.
**Last updated:** 2026-09-03
**HEAD:** `3341949` (ST-9/12/13, dispute resolution, durable mission/opportunity wiring, UI-4, real Stripe test-mode provider — committed) + uncommitted this session: real Circle Developer-Controlled Wallets stablecoin provider (per-milestone async transfers, idempotent execute, `POST /webhooks/circle` reconciliation) + the shared `"pending"` vs `"confirmed"` release fix it required (also benefits Stripe)
**Purpose:** Living memory of *what actually exists in the codebase* and *what is next*. This supersedes the original concept-capture memory (`AI_Opportunity_Operating_System_Project_Memory.md`) for engineering purposes. Requirements live in `Opportunity_OS_TECHNICAL_REQUIREMENTS.md`; rationale lives in `docs/adr/`.

---

## 1. What this is

A model-agnostic, demand-first economic coordination platform that continuously discovers lawful unmet demand and underutilized supply, converts them into structured economic objects, matches them, scores economics + risk deterministically, and presents actionable opportunities to a human operator. It is reframing from a "marketplace aggregator" into a **transaction-discovery network + transaction operating system**: opportunities can arise from *any* signal channel (even by connecting two independent facts with no listing), and every completed deal feeds a learning loop.

Human control is preserved over outbound negotiation, binding commitments, purchases, and movement of money. Fiat and blockchain settlement are native architectural capabilities from day one behind one abstraction.

Internal spine:
`Signals → (Entities/Graph) → Supply → Demand → Matches → Opportunities → Negotiations → Transactions → Settlement → Outcomes`

## 2. Repository shape

Monorepo: pnpm workspaces + Turborepo, TypeScript strict, ESM. Node via `.nvmrc`. `DATABASE_URL`-driven Postgres.

- **19 packages** (`packages/*`): `contracts`, `config`, `ids`-in-contracts, `domain`, `audit`, `auth`, `risk`, `scoring`, `demand`, `discovery`, `connectors-sdk`, `verifiers-sdk`, `negotiation`, `escrow`, `settlement`, `chain`, `llm-gateway`, `observability`, `db`, `ui`.
- **8 apps** (`apps/*`): `api` (NestJS/Fastify), `web` (Next.js), `worker-outbox`, `worker-connectors`, `worker-lifecycle`, `worker-temporal`, `worker-notifications`, `worker-agents`.
- **16 SQL migrations** (`packages/db/migrations/0001`–`0016`), 22 tables, forward-only idempotent runner.
- **31 ADRs** (`docs/adr/ADR-001`–`031`).
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
| `api` | NestJS/Fastify REST + OpenAPI. Modules: health, missions, opportunities, approvals, transactions, settlement, signals, entities, public, webhooks. | Built |
| `web` | Next.js operator/user UI. Pages: home, missions/[id], opportunities, opportunities/[id], approvals, transactions/[id], payments, archive, settings. | Scaffolded, all 9 screens present |
| `worker-outbox` | Transactional-outbox relay (log + Redis publishers). | Built |
| `worker-connectors` | Risk-gated ingestion loop across registered connectors. | Built (fixture + adapter connectors) |
| `worker-lifecycle` | Periodic refresh sweep: discovery + synthesis + entity resolution + graph edges + graph deals. | Built |
| `worker-temporal` | Durable workflows (mission discovery, opportunity execution / approval-wait, settlement milestone timer). | Built (verified against time-skipping test server); all three now started from `apps/api` as opt-in durable paths |
| `worker-notifications` | Approval delivery loop (Telegram/email/log), marks notified. | Built |
| `worker-agents` | Agent runtime host. | Stub / minimal |

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
  - **Verified**: a pure-crypto self-test (`scripts/verify-circle-provider.ts`, no account needed) proves `verifyCircleSignature` accepts a correctly-signed payload and rejects a wrong-key or tampered one — all 3 checks pass. **Not yet verified**: an actual Circle sandbox transfer — no `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID` were available this pass (the user opted to build the code now and complete Circle's account setup — generating + registering an entity secret, provisioning and funding a Base Sepolia wallet — afterward, unlike the Stripe pass where a key was pasted mid-session). The live half of the script (a real testnet USDC transfer to a freshly-created temporary destination wallet, polled to on-chain `COMPLETE`) is ready to run once those exist.
  - **UI gap this surfaced, since closed**: the Payments page's create-milestone form (UI-4, built before this pass) had no recipients field. Fixed same session: an editor (address + a shared split-by-percentage/amount kind, add/remove rows) now lets a milestone get a real payout address through the console, not just the API — required for a stablecoin release to be driven from the UI at all. Smoke-tested in a real browser (Playwright, mocked API response) — renders and adds/removes rows with no console errors.

Remaining (Phase 3):
1. Live-verify the Circle wiring once sandbox credentials + a funded Base Sepolia wallet exist.
2. Recipient-level webhook reconciliation for both providers (Stripe Transfers, Circle per-recipient transactions on a split).
3. Durable milestone-*evidence* waits, as opposed to the release-window waits ST-13 already covers (WF-3 remainder).
4. `executeRefund`'s parallel "pending refund" gap (documented, currently unreachable — no rail refunds asynchronously today).
5. A real rail is not the same as a *production* one (§C-6): going live needs a licensed money-transmitter partnership + an audit for both Stripe and Circle — a business/compliance decision, not a code change. The on-chain/`chain` family remains a local/simulated reference pending its own real provider.

### Phase 4 — Public Demand Marketplace 🟡 (scaffolded)
All 9 required screens exist as Next.js pages (home/search, missions/[id], opportunities, opportunities/[id], approvals, transactions/[id], payments, archive, settings) with a typed API client; payments is no longer read-only (UI-4, above). Remaining: polish Search/Ask, mission history/archive depth, richer transaction timeline, sharing permissions, user↔agent steering.

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

## 7. Engineering conventions

- Package resolution: `@opportunity-os/*` → `packages/*/src/index.ts` (tsconfig paths + vitest alias). New packages need `package.json` + `tsconfig.json` and a workspace install.
- jsonb writes: `JSON.stringify` arrays/objects (node-pg treats bare JS arrays as Postgres array literals).
- State transitions: always via `assertTransition` + an audit event in the same DB transaction.
- Tests: vitest; `packages/**`, `apps/**`, `tests/**` included. Live-DB e2e gated by `DATABASE_URL` (`describe.skipIf(!HAS_DB)`); pgvector e2e is CI-only (skips on plain Postgres). Verify against a throwaway Postgres, batch typecheck + full suite at the end.
- Current health: **suite 86 pass / 1 skip (30 files); typecheck 46/46.**

## 8. Configuration surface (env)

`NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `SUPABASE_*`, `REDIS_URL`, `TEMPORAL_*`, `LLM_DEFAULT_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`/`EMBEDDING_BACKEND`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, `DEFAULT_STABLECOIN_NETWORK`, `CHAIN_RPC_URL`, `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID`, `TELEGRAM_*`/`EMAIL_FROM`/`SMTP_URL`, `APPROVAL_TOKEN_SECRET`, `AUDIT_ANCHOR_ENABLED`, `APPROVAL_TIMEOUT_MINUTES`, `MISSION_REFRESH_INTERVAL_MINUTES`, `SUPPLY_STALE_MINUTES`, `SETTLEMENT_AUTO_RELEASE_THRESHOLD_MINOR`. All validated in `config`; safe defaults let dev/CI run keyless.

## 9. ADR index

001 TS monorepo · 002 Next.js FE · 003 NestJS/Fastify · 004 modular-first · 005 Postgres/Supabase SoR · 006 Temporal durable workflows · 007 transactional outbox · 008 central LLM gateway · 009 policy-enforced human approval · 010 rail-neutral settlement · 011 blockchain for settlement proofs only · 012 hash-chained audit · 013 Railway-first/AWS-portable · 014 permitted/authorized sources only · 015 deterministic final scoring · 016 V1 decision-packet defaults · 017 lifecycle worker drives V1 discovery · 018 demand parser LLM+heuristic · 019 approval tokens + synchronous execution · 020 LLM negotiation drafting · 021 durable approval-wait workflow · 022 signals→outcomes transaction-discovery network · 023 market graph + entity resolution · 024 embeddings + graph edges · 025 embedding provider · 026 pgvector backend · 027 graph-derived opportunities · 028 risk-gated channel adapters · 029 escrow condition/release engine · 030 rail execution · 031 refund/dispute execution.

No new ADR filed for the ST-13 timer workflow — it applies ADR-006 (Temporal) and ADR-029's release engine to real timestamps rather than introducing a new decision.

## 10. Immediate next options

Ordered by leverage on the Transaction-OS thesis. Both money rails (fiat/Stripe, stablecoin/Circle) are now real and the create-milestone UI can drive both — the honest next step is verifying Circle live, not more wiring:
1. **Live-verify Circle** — `scripts/verify-circle-provider.ts` is ready; run it once sandbox credentials + a funded Base Sepolia wallet exist.
2. **A licensed money-transmitter partnership + audit** (§C-6) — the actual gate to going live with real funds on either rail; a business/compliance decision, code changes alone can't cross it.
3. **Recipient-level webhook reconciliation** — the remaining gap for both Stripe (Transfers) and Circle (per-recipient transactions on a split).
4. **Phase 4 polish** — sharing permissions + user↔agent steering + richer mission/transaction timelines.
5. **Phase 5 learning loop** — outcome-driven score calibration + connector-yield optimization.
6. **A full AND/OR escrow-condition builder in the UI** — the create-milestone form only offers a single predicate; the API already supports arbitrary trees.
