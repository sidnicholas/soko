# Opportunity OS — V1 Technical Requirements

**Version:** 1.6 (build-reflecting)
**Status:** Living. Phases 0–3 satisfied (Phase 3's fiat rail is real Stripe test-mode and the stablecoin rail is real Circle Developer-Controlled Wallets on Base Sepolia; the on-chain/`chain` family remains a local reference); Phases 4–5 partial.
**Date:** 2026-09-03
**Reads with:** `Opportunity_OS_PROJECT_MEMORY.md` (state), `Opportunity_OS_V1_Technical_Specification.md` (original spec, section numbers `§` referenced here), `docs/adr/*` (decisions).

Legend: **[DONE]** implemented + tested · **[PARTIAL]** implemented with named gaps · **[TODO]** not yet built. Every requirement is phrased to be verifiable.

---

## 0. Product constraints (locked)

- **C-1** Geography: United States. **[DONE]** (policy defaults)
- **C-2** Model-agnostic: no business logic hard-bound to one LLM; provider chosen by config/task profile. **[DONE]** (`llm-gateway`)
- **C-3** Human control retained over outbound negotiation, binding commitments, purchases, and money movement. **[DONE]**
- **C-4** Fiat + blockchain settlement are native from day one behind one abstraction. **[DONE]**
- **C-5** Deterministic, versioned, auditable decisions for scoring and release; LLM may estimate, never decide. **[DONE]**
- **C-6** Platform never holds private keys; production fiat via licensed partner; on-chain funds live in the contract. **[DONE-by-design]** (the fiat rail now runs real Stripe test-mode calls when `STRIPE_SECRET_KEY` is set — no simulation — but that's still Stripe holding funds in escrow-like PaymentIntents, not a licensed money-transmitter partner; going live requires that partner relationship + an audit, a business decision, not a code change. Stablecoin/chain rails remain local references.)

## 1. Architecture

- **A-1** TypeScript monorepo, pnpm workspaces + Turborepo, strict TS, ESM. **[DONE]** (ADR-001)
- **A-2** Modular-first, microservice-ready: domain logic in packages, thin apps. **[DONE]** (ADR-004)
- **A-3** NestJS on Fastify for the API; OpenAPI generated. **[DONE]** (ADR-003)
- **A-4** Next.js frontend. **[DONE]** (ADR-002)
- **A-5** PostgreSQL (Supabase-compatible) as system of record; portable to plain Postgres. **[DONE]** (ADR-005)
- **A-6** Redis for transport/queues. **[DONE]** (outbox relay publisher)
- **A-7** Temporal for durable workflows. **[DONE]** (ADR-006; verified on time-skipping server)
- **A-8** Railway-first deploy, AWS-portable via OCI containers; infra under `/infra`. **[PARTIAL]** (manifests exist; AWS templates deferred, ADR-013)

## 2. Domain model (§6)

- **D-1** All 22 entities modeled as Zod contracts + Kysely tables + migrations. **[DONE]**
  Tables: users, missions, mission_versions, demands, supply, matches, opportunities, counterparties, approvals, negotiations, transactions, settlement_plans, settlement_milestones, evidence, audit_events, outbox, signals, outcomes, entities, entity_members, price_observations, graph_edges.
- **D-2** `DemandSpecification` contract (§7) with what/budget/quality/timing/importance/payment/fulfillment/flexibility/negotiationAuthorization; `maySend=false` by default. **[DONE]**
- **D-3** Mission versioning: each material change creates an immutable `mission_versions` row; prior versions never mutated. **[DONE]**
- **D-4** Counterparty identity: no cross-source identity merge from LLM inference alone; deterministic/human-reviewed evidence above a threshold. **[PARTIAL]** (entity resolution uses deterministic canonical keys; trust-tier merge threshold + human review path TODO)

## 3. Contracts, events, outbox

- **E-1** 41 canonical, versioned event names (`*.v1`) in one enum; typed `EventEnvelope`. **[DONE]**
- **E-2** Transactional outbox: DB write + event enqueue in one transaction; idempotency key per event; relay publishes + marks published. **[DONE]** (ADR-007)
- **E-3** Consumers dedupe via idempotency key. **[DONE]** (relay `--once` + markers)

## 4. Demand intake & parsing

- **DP-1** Natural-language + structured intake → `DemandSpecification` via LLM with deterministic heuristic fallback (keyless-testable). **[DONE]** (ADR-018)
- **DP-2** Public intake `POST /public/requests` creates a mission from plaintext, autonomy `discover_only`. **[DONE]**
- **DP-3** Signals intake `POST /signals` (multi-channel: public_web, official_api, browser_extension, user_submitted, merchant_feed) captures provenance + content hash, rejects prompt-injection, projects into supply/demand. **[DONE]** (ADR-022, ADR-028)

## 5. Connectors & ingestion (§17)

- **CN-1** `SourceConnector` interface (id, capabilities, policy, search/fetch/verify?). **[DONE]**
- **CN-2** Connector policy declares automation method; V1 must not build around prohibited scraping. **[DONE]** (ADR-014)
- **CN-3** Real adapter shapes: HTTP-API (official API/licensed feed) + crawl (permitted public fetch), injectable `fetch`, keyless-testable, key-ready. **[DONE]** (ADR-028)
- **CN-4** Risk-gated ingestion: skip non-permitted automation; drop non-transactable categories + prompt-injection content; persist the rest. **[DONE]**
- **CN-5** Fixtures provide a deterministic demand+supply match for tests. **[DONE]**
- **CN-6** Runtime robots.txt/ToS fetch + rate-limit enforcement in the crawl adapter. **[TODO]**

## 6. Matching, scoring, economics (§12)

- **SC-1** Deterministic matching pairs demand↔supply with sub-scores (semantic, constraint, geography, timing, quality). **[DONE]**
- **SC-2** Versioned deterministic ranking function (`SCORE_VERSION`) over normalized component scores + explicit economics; LLM may estimate components only. **[DONE]** (ADR-015)
- **SC-3** A tiny near-certain zero-capital opportunity can outrank a large capital/effort one. **[DONE]** (reward/penalty + diminishing-returns curves)
- **SC-4** Cross-source synthesis: every open demand matched against all supply regardless of source; shared `scoreAndPersistOpportunity`; idempotent on `(demand_id, supply_id)`. **[DONE]** (ADR-022)
- **SC-5** Graph-derived opportunities: `ARBITRAGE`/`BUNDLE_AVAILABLE` edges become first-class deals on the feed (nullable `match_id`, `dedupe_key`). **[DONE]** (ADR-027)

## 7. Entity resolution & market graph (§ defensibility)

- **G-1** Canonical entity resolution (category + normalized token signature) groups observations of the same item across sources into `entities` + `entity_members`. **[DONE]** (ADR-023)
- **G-2** Price history via `price_observations`; `entityPriceStats` (min/median/max/count). **[DONE]**
- **G-3** Market graph `graph_edges`: `SUBSTITUTE_OF`, `ARBITRAGE`, `BUNDLE_AVAILABLE`; SQL top-K substitutes (LATERAL) + cross-entity arbitrage (vector+price join). **[DONE]** (ADR-024, ADR-027)
- **G-4** Entity embeddings for similarity: `EmbeddingModel` via gateway (echo default, OpenAI/Voyage), jsonb storage with pgvector opt-in (`EMBEDDING_BACKEND`), HNSW + cosine in SQL. **[DONE]** (ADR-024/025/026)
- **G-5** Graph analytics at scale (Neo4j/Memgraph/Neptune) when justified. **[TODO]** (Phase 5)

## 8. LLM gateway (§18)

- **LM-1** Provider routing, task profiles, fallback chain, structured outputs, per-task budgets, timeout, retries, redaction, model/version logging, cost telemetry. **[DONE]** (ADR-008; echo fallback keeps dev/CI deterministic)
- **LM-2** Embedding models routed through the same gateway. **[DONE]** (ADR-025)
- **LM-3** Evaluation hooks + caching where safe. **[PARTIAL]** (telemetry present; eval hooks minimal)

## 9. Risk, compliance, anti-gaming (§13)

- **R-1** Category gate: allowed / review_required / prohibited_for_v1; unknown defaults to review. **[DONE]**
- **R-2** Source trust metadata on every observation (source, method, timestamp, reliability, verification). **[DONE]**
- **R-3** Prompt-injection defense: untrusted content detected + segregated; no model self-grants permissions; high-impact tools require policy authorization. **[DONE]** (detection in `risk`, enforced at signal + ingestion)
- **R-4** Financial safety: per-action/per-day limits, allowlisted providers, human approval for fund movement, no LLM-exposed keys. **[PARTIAL]** (spend-limit checks + approval gate done; per-day accounting + allowlist enforcement TODO)
- **R-5** Marketplace gaming detection (duplicate/synthetic demand+supply, Sybil, circular/self-dealing, price anomalies, fake ratings, velocity). **[PARTIAL]** (anti-gaming assessment scaffolding; full detector suite TODO, Phase 5)

## 10. Approval architecture (§14)

- **AP-1** Approval is a policy-enforced command, not chat: request → mint signed one-time action token (action + payload hash + expiry) → decision → verified execution. **[DONE]** (ADR-009/019)
- **AP-2** Separation of duties: an agent may create an approval but never approve; proposer ≠ approver. **[DONE]**
- **AP-3** Approval invalid if material terms change after grant (`materialTermsChanged`). **[DONE]**
- **AP-4** Notification delivery (Telegram + email) with a delivery worker; marks notified once. **[DONE]**
- **AP-5** Decision channels approve/reject/modify/review; modify re-mints. **[DONE]**

## 11. Temporal workflows (§11)

- **WF-1** Mission Discovery Workflow: parse → policy → schedule connectors → normalize → match → score → risk → persist → notify → periodic refresh. **[DONE]** (logic shared with lifecycle worker, ADR-017). Wired into live traffic as an opt-in: `POST /missions/:id/discover-durable` starts it (`apps/api/src/missions/temporal.ts`); `listActiveMissionsForDiscovery` excludes any mission with a recorded `temporal_workflow_id` so the durable path and `worker-lifecycle`'s own sweep never double-drive the same mission; pause/resume/archive forward the corresponding signal to a running workflow. A mission that never opts in keeps working exactly as before.
- **WF-2** Opportunity Execution Workflow: reverify → recalc → risk → prepare negotiation → request approval → wait for signal (bounded) → execute on approve; reject/timeout no-op. **[DONE]** verified on time-skipping server (ADR-021). Wired into live traffic as an opt-in: `POST /opportunities/:id/execute-durable` starts it instead of `requestApproval`'s direct `createApproval` call (the workflow's own first activity creates the approval identically, so it shows up in the normal approvals inbox unchanged); `ApprovalService.decide` best-effort signals the matching workflow (`opp-exec:<opportunityId>`) with the decision + minted token — a no-op (caught `WorkflowNotFoundError`) for the default non-durable path.
- **WF-3** Settlement Workflow: durable milestone-evidence waits + release waits. **[PARTIAL]** `settlementMilestoneTimerWorkflow` (ST-13) durably drives the optimistic/deadman release windows, script-verified and wired into live traffic (`POST /settlement/plans/:planId/milestones` starts it, best-effort, via `apps/api/src/settlement/temporal.ts`). All three Temporal workflows are now called from `apps/api`. Durable milestone-*evidence* waits (as opposed to release-window waits) remain TODO.

## 12. Settlement & escrow (§19, §20)

- **ST-1** Rail-neutral `SettlementRail` interface + `SettlementService` registry; transactions never coupled to one rail. **[DONE]** (ADR-010)
- **ST-2** Fiat rail on Stripe test mode (simulated with no key; manual-capture PaymentIntent = authorize, capture = release; real Stripe API calls when `STRIPE_SECRET_KEY` is set — no simulation gap). **[DONE]** Real-mode fix: a PaymentIntent can only be captured once, so a shared plan-level intent broke the second milestone's release on an actual multi-milestone plan (invisible under simulation, which never enforces that). Each milestone that needs its own reference (`capabilities().supportsMilestones: false`) now gets its own PaymentIntent, prepared lazily on first release/refund for exactly that milestone's amount (`settlement_milestones.provider_ref`, migration 0016); `refund()` cancels an uncaptured intent instead of erroring on "not captured yet" and only creates a real Refund post-capture; `execute()`/`refund()`/`prepare()` pass Stripe idempotency keys (the already-computed `approvalTokenHash`, or a deterministic refund/prepare key) so a Temporal-retried activity can't double-capture/double-transfer/double-refund; `prepare()` also pins `payment_method_types: ["card"]` (an account with automatic payment methods enabled otherwise demands a `return_url` this server-side flow has no concept of). **Passed live against the real Stripe test API** (`scripts/verify-stripe-provider.ts`, 9/9 checks, `sk_test_...`, no simulation) — including the one that would have failed outright pre-fix: two milestones of one plan each capturing their own PaymentIntent.
- **ST-3** Stablecoin rail (configurable asset/network; deterministic simulation with no Circle config; real Circle Developer-Controlled Wallets calls otherwise — Circle holds the platform's keys via MPC custody, so this stays consistent with §C-6 rather than the platform signing on-chain transactions itself). **[DONE]** `execute()` requires at least one ST-12 recipient (there's no implicit "platform balance" landing zone for an on-chain transfer the way Stripe capture has) and always returns `"pending"` — Circle transfers are asynchronous (`INITIATED → ... → COMPLETE`, minutes away), never synchronously confirmed. `supportsRefund` stays `false`: on-chain has no "reverse this charge" primitive, only "send more USDC somewhere," and no buyer refund address is tracked anywhere in the data model. **Live-verified** against the real Circle sandbox API + Base Sepolia (`scripts/verify-circle-provider.ts`, 9/9 checks): a real `execute()` call submitted an actual on-chain USDC transfer that confirmed on-chain (real `txHash`, real block), polling through `INITIATED → ... → CONFIRMED → COMPLETE`, with `status()` correctly mapping it to `"confirmed"`. The live run caught a real bug no typecheck could: Circle's `idempotencyKey` must be **UUID-shaped** — the original `${approvalTokenHash}:${address}` key (unique, but not UUID syntax) was rejected outright by the live API; fixed with a deterministic hash-to-UUID helper so retries still dedupe on the same key. Wallet setup (entity secret registration, wallet-set/wallet creation on `BASE-SEPOLIA`) is fully scripted; funding needed Circle's web faucet manually — the SDK's own `requestTestnetTokens` API returned `Forbidden` for this sandbox account, an account-level Circle restriction, not a code gap. The Payments page's create-milestone form (UI-4) exposes a recipients editor (address + split-by-percentage/amount, add/remove rows) so a stablecoin milestone can be given a payout address through the UI, not just the API.
- **ST-4** Programmable-chain adapter: milestone state, release authorization, multi-recipient split, event emission, dispute/freeze, refund — local/testnet reference. **[DONE]** (in-memory reference; on-chain contract needs audit, ADR-011)
- **ST-5** Progressive settlement state machine (DRAFT→…→SETTLED with DISPUTED/FROZEN), every transition policy-checked + audited. **[DONE]** (`domain`)
- **ST-6** **Escrow condition engine**: versioned AND/OR predicate DSL; pure evaluator is the sole authority for MILESTONE_VERIFIED; minimum trust tier per leaf. **[DONE]** (ADR-029)
- **ST-7** **Evidence ledger**: append-only, hash-chained per entity; verifier + trust tier + predicate recorded; `verifyEvidenceChain`. **[DONE]**
- **ST-8** **Verifier adapters**: pluggable `EvidenceVerifier`; local attestation + deterministic e-signature references; production carrier/e-sign/oracle verifiers implement the same shape. **[DONE]**
- **ST-9** **Release policy**: auto-release below threshold, human dual-control above (approval token bound via `hashReleaseTerms`), optimistic window, deadman auto-refund. **[DONE]** decision + effects; windows are persisted per-milestone (`optimistic_after_at`/`deadman_at`, migration 0012) and driven automatically by the ST-13 timer workflow for the auto_refund and below-threshold auto_release branches. `POST /settlement/milestones/:id/release` now also accepts a still-"pending" milestone: it reads the real `conditionSatisfied`/windows into `decideRelease` (previously hardcoded `conditionSatisfied: true`, silently dropping the optimistic/deadman branches) and, on `require_approval` above threshold with a valid token, calls `verifyMilestone` before executing — closing the gap where an elapsed optimistic window above threshold had a decision but no execution path.
- **ST-10** **Rail execution on release**: prepare at fund, execute at release, `provider_ref` + `external_transaction_ref` persisted; execute refuses empty token hash; rail failure aborts DB release. **[DONE]** (ADR-030)
- **ST-11** Refund/dispute execution: wire `auto_refund`/`hold` to rail refund + DISPUTED/FROZEN ops. **[DONE]** (ADR-031: REFUNDED terminal status + migration 0011; `disputeMilestone`/`freezeSettlementPlan`/`refundMilestone` repos; `POST /settlement/milestones/:id/{dispute,refund}` + `POST /settlement/plans/:id/freeze`; `release()` reads real disputed state and executes refund on `auto_refund`. Automatic deadman-triggered refund fires via ST-13's durable timer workflow, not only the manual refund endpoint.) **Dispute/freeze resolution** (migration 0013): `pre_dispute_status`/`pre_freeze_status` remember what a plan/milestone was before dispute/freeze; new `resolveDispute`/`unfreezeSettlementPlan` repos restore it (new reverse edges in `SETTLEMENT_TRANSITIONS`: `DISPUTED`/`FROZEN` → their prior states) so a dispute can resolve back to releasable instead of only via refund; `POST /settlement/milestones/:id/resolve-dispute` + `POST /settlement/plans/:id/unfreeze` (permission `settlement:dispute`, no token); new events `settlement.dispute_resolved.v1`/`settlement.unfrozen.v1`.
- **ST-12** Multi-party splits: populate `recipients` + execute multi-recipient payout. **[DONE]** `MilestoneRecipient` contract + `recipients_json` on `settlement_milestones` (migration 0014), settable at creation (`POST /settlement/plans/:planId/milestones`) and validated eagerly (same kind, sum equals the milestone amount — `resolveRecipients`, duplicated between `settlement.service.ts` and the timer activity per the existing sync/durable-path duplication convention). `ExecutionResult` gained an optional `recipients` breakdown; `StripeFiatRail` executes real per-recipient `transfers.create` (Connect destination model) when not simulated, `StablecoinRail`/`ProgrammableSettlementAdapter` simulate deterministically; `release()` refuses a split on a rail that doesn't advertise `supportsMultiRecipient` and persists each recipient's executed `externalRef` back onto the milestone.
- **ST-13** Persisted optimistic/deadman windows (migration 0012, `POST /settlement/plans/:planId/milestones`) + durable Settlement Milestone Timer Workflow (`worker-temporal`: `settlementMilestoneTimerWorkflow` + `checkMilestoneTimerActivity`) that sleeps to the next window and auto-executes `auto_refund`/`auto_release` (including ST-12 recipient splits) exactly like the manual HTTP paths; a disputed plan or an above-threshold optimistic release is reported "held" rather than acted on. **[PARTIAL]** verified via `scripts/verify-settlement-timer-workflow.ts` against the time-skipping Temporal test server, and wired into live traffic (see WF-3). Idempotent execute for Stripe/Circle is now **[DONE]** (ST-2/ST-3, above) and the timer activity shares the same idempotency-safe path.

  Async provider status reconciliation is now **[PARTIAL]**, and — with a real async rail (Circle) now wired — this stopped being a Stripe-only fallback path. Fixed the shared gap it was exposing: `release()`/`checkMilestoneTimerActivity` used to treat ANY non-`"failed"` execute() result as fully released immediately, including `"pending"` — invisible for Stripe (cards usually confirm synchronously) but the *normal* case for Circle (on-chain transfers are never synchronously confirmed). Both now call the new `markMilestoneReleasePending` (persists the reference, milestone stays `"verified"`) instead of `releaseMilestone` when the rail reports `"pending"`; a webhook finalizes it later. `POST /webhooks/stripe` verifies Stripe's real signature scheme over the raw request body and reconciles `payment_intent.succeeded`/`charge.refunded`/`payment_intent.payment_failed`/`charge.dispute.created` by correlating to `settlement_milestones.provider_ref`. `POST /webhooks/circle` (new) verifies Circle's asymmetric `ECDSA_SHA_256` signature (fetches + caches the signing public key by the `X-Circle-Key-Id` header via `getNotificationSignature`) and reconciles by the transaction id against `settlement_milestones.external_transaction_ref` (a different column than Stripe's — Circle's `provider_ref` holds the shared wallet id, not a per-transaction reference). Not yet reconciled for either provider: recipient-level events (Stripe `transfer.reversed`, Circle per-recipient transactions on an ST-12 split) — a multi-recipient release submits one transaction per recipient but only the first's id is tracked on the milestone. Also not yet fixed: `executeRefund`'s parallel "pending refund" case (currently unreachable — no rail refunds asynchronously today).
- **ST-14** Off-chain/on-chain split: only hashes/attestations on-chain; PII + terms off-chain. **[DONE]** (`chain` anchor helpers)

## 13. Audit & integrity (§21)

- **AU-1** Append-only, hash-chained audit: `event_hash = HASH(previous + canonical_payload)`; advisory-locked appends. **[DONE]** (ADR-012)
- **AU-2** `verifyChain` recomputes + detects tampering; `audit.integrity_failed.v1` on break. **[DONE]**
- **AU-3** Batch/root-hash anchoring to an external immutable system (no private data). **[PARTIAL]** (`computeBatchRoot` + `buildAnchorPayload` exist; scheduled anchoring behind `AUDIT_ANCHOR_ENABLED`, wiring TODO)

## 14. AuthN/Z (§22)

- **AZ-1** Supabase Auth for authentication; domain authorization application-owned. **[PARTIAL]** (dev header shim; Supabase JWT verification swap-in documented, TODO for prod)
- **AZ-2** RBAC (user/operator/reviewer/admin/service/agent) + attribute gate requiring an approved token for high-impact actions. **[DONE]**
- **AZ-3** Row-Level Security on user-facing tables; portable `auth.uid()` shim. **[DONE]**
- **AZ-4** `settlement:release` is plain-gated; money control is the release engine + cryptographic token (auto below threshold, human above). **[DONE]**

## 15. Frontend (§15)

- **UI-1** Nine required screens present as Next.js pages: Search/Ask home, mission detail, opportunities list, opportunity detail, approvals inbox, transaction detail/timeline, payments/settlement, archive/history, account/security settings. **[PARTIAL]** (all scaffolded with typed API client; polish + depth TODO)
- **UI-2** Mission detail shows request, editable constraints, agent status, opportunities, rejected alternatives w/ reason, activity timeline, questions, pause/resume/archive, sharing placeholder. **[PARTIAL]**
- **UI-3** Future-ready UX: shared missions, collaborators, comments, sell-side, user↔agent steering, history, reusable/recurring searches — data model/API ready. **[PARTIAL]** (schema supports; UI + sharing-permission enforcement TODO)
- **UI-4** Milestone/release UI (fund, submit evidence, view ledger, release). **[DONE]** Payments page: fund plan, freeze/unfreeze (with reason), create-milestone form (single-predicate release condition — a full AND/OR tree builder is left to the API), per-milestone evidence submission + ledger view, release (optional approval-token input), dispute/resolve-dispute, refund — every action just calls the gated endpoint, no client-side policy logic.

## 16. API surface (§16)

- **API-1** Missions CRUD + pause/resume/archive + opportunities + `discover-durable` (opt into the Temporal discovery workflow). **[DONE]**
- **API-2** Opportunities list/detail/reverify/prepare-negotiation/record-outcome + `execute-durable` (opt into the Temporal execution workflow). **[DONE]**
- **API-3** Approvals list/detail/approve/reject/modify. **[DONE]**
- **API-4** Transactions detail/settlement-plan/timeline/propose. **[DONE]**
- **API-5** Settlement: create milestone (ST-12 recipients + ST-13 windows), fund plan, submit evidence, evidence ledger, release, dispute/resolve-dispute/freeze/unfreeze/refund. **[DONE]**
- **API-6** Signals intake; entities/graph intelligence read. **[DONE]**
- **API-7** Webhooks: stripe/circle/telegram/chain. **[PARTIAL]** Stripe and Circle (new) verify each provider's actual signature scheme over the raw body and reconcile settlement state (see ST-13); telegram/`chain` (the `onchain_programmable` family, distinct from Circle's `stablecoin` family) still verify against a re-serialization of the parsed body via a generic HMAC helper, not each provider's real scheme.
- **API-8** Public requests intake. **[DONE]**
- **API-9** OpenAPI generation + typed frontend client. **[PARTIAL]** (OpenAPI via Nest/Swagger; hand-written typed client in web, generated client TODO)

## 17. Observability (§25)

- **OB-1** Structured JSON logs with correlation/mission/opportunity/workflow/agent-task IDs, model/provider/version, LLM + connector cost, settlement ref, error class, latency, retries. **[PARTIAL]** (structured logger + key fields; full telemetry surface + dashboards TODO)
- **OB-2** Operator dashboards (opportunities/hr, qualified rate, profit pipeline, realized profit, close rate, time-to-cash, ROI, approval latency, connector yield, LLM spend/opp, fraud flags). **[TODO]** (Phase 5)

## 18. Testing (§26)

- **T-1** Unit: scoring, economics, matching, parser, escrow evaluator, release policy, verifiers, approval token, audit chain, embeddings. **[DONE]**
- **T-2** Integration/e2e (live Postgres): golden path, discovery loop, lifecycle refresh, signals synthesis, market graph, graph deals/edges, approval loop, negotiation draft, escrow, rail execution, pgvector (CI-only). **[DONE]**
- **T-3** Determinism + idempotency asserted (migrations, upserts, refresh cycles, hash chains). **[DONE]**
- **T-4** Adversarial/security suite (prompt injection, tamper, gaming). **[PARTIAL]** (injection + tamper covered; gaming detectors TODO)
- **T-5** Health gate: full suite + typecheck green before push. **[DONE]** (currently 86 pass / 1 skip; typecheck 46/46)

## 19. Deployment & data (§23, §24)

- **DE-1** All business services ship as OCI containers; Railway V1; infra in `/infra`. **[PARTIAL]**
- **DE-2** Secrets only via env/secret manager; never store payment credentials; never PII on-chain; retention policies. **[PARTIAL]** (config-driven secrets; formal retention policy TODO)
- **DE-3** AWS scale target (ECS/Fargate, Aurora, ElastiCache, S3, KMS, OpenSearch) — templates early, deploy only when justified. **[TODO]** (Phase 5)

---

## 20. Phase gates & exit criteria

- **Phase 0** Foundation — **MET.**
- **Phase 1** Economic Nervous System — exit: real/test-source opportunities automatically enter the DB, match, score, refresh, and appear without manual hunting — **MET.**
- **Phase 2** Human-Controlled Execution — exit: an approved command executes a binding proposal behind a cryptographic human gate with audit-backed execution, verified durably — **MET.**
- **Phase 3** Native Money Rails — exit: a release moves funds on a selected rail behind the escrow engine + evidence ledger + release policy — **MET, including two real, live-verified providers (ST-1..ST-14, UI-4, WF-1..WF-3):** the fiat rail runs real Stripe test-mode API calls when `STRIPE_SECRET_KEY` is set, and the stablecoin rail runs real Circle Developer-Controlled Wallets calls (custodial — Circle holds keys, not the platform, per §C-6) when `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_WALLET_ID` are set; both idempotent, both webhook-reconciled, both proven against their real sandbox APIs — Stripe with a real capture/refund, Circle with a real on-chain USDC transfer confirmed on Base Sepolia. The on-chain/`chain` family (`ProgrammableSettlementAdapter`) remains a local reference. Open: recipient-level webhook reconciliation for both providers, durable milestone-evidence waits, and — a business/compliance decision, not a code change — an actual licensed money-transmitter partnership + audit for going live with real funds (§C-6).
- **Phase 4** Public Demand Marketplace — exit: polished operator/user surface with sharing + steering. **PARTIAL** (screens scaffolded).
- **Phase 5** Learning & Scale — exit: outcome-driven calibration + search/graph scale + increased policy-bounded automation. **TODO.**

## 21. Open requirement backlog (net-new, ordered)

1. ST-13/WF-3 remainder: recipient-level webhook reconciliation (both providers), durable milestone-*evidence* waits, and `executeRefund`'s parallel pending-refund gap.
2. UI-1/2/3 polish: sharing permissions, agent steering, richer mission/transaction timelines.
3. R-4/R-5 Financial per-day accounting + full anti-gaming detectors.
4. OB-1/OB-2 Telemetry surface + operator dashboards.
5. G-5 Graph analytics at scale; SC/Phase-5 outcome-driven score calibration + connector-yield optimization; search index.
6. AZ-1 Supabase JWT production auth; telegram/chain webhooks verified against their own real schemes (Stripe/Circle are now done); API-9 generated client.
7. DE-1/2/3 Infra hardening + retention + AWS templates.
