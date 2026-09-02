# Opportunity OS — V1 Technical Requirements

**Version:** 1.2 (build-reflecting)
**Status:** Living. Phases 0–2 satisfied; Phase 3 partial; Phases 4–5 partial.
**Date:** 2026-09-02
**Reads with:** `Opportunity_OS_PROJECT_MEMORY.md` (state), `Opportunity_OS_V1_Technical_Specification.md` (original spec, section numbers `§` referenced here), `docs/adr/*` (decisions).

Legend: **[DONE]** implemented + tested · **[PARTIAL]** implemented with named gaps · **[TODO]** not yet built. Every requirement is phrased to be verifiable.

---

## 0. Product constraints (locked)

- **C-1** Geography: United States. **[DONE]** (policy defaults)
- **C-2** Model-agnostic: no business logic hard-bound to one LLM; provider chosen by config/task profile. **[DONE]** (`llm-gateway`)
- **C-3** Human control retained over outbound negotiation, binding commitments, purchases, and money movement. **[DONE]**
- **C-4** Fiat + blockchain settlement are native from day one behind one abstraction. **[DONE]**
- **C-5** Deterministic, versioned, auditable decisions for scoring and release; LLM may estimate, never decide. **[DONE]**
- **C-6** Platform never holds private keys; production fiat via licensed partner; on-chain funds live in the contract. **[DONE-by-design]** (execution rails are simulated/local references pending provider + audit)

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

- **E-1** 36 canonical, versioned event names (`*.v1`) in one enum; typed `EventEnvelope`. **[DONE]**
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

- **WF-1** Mission Discovery Workflow: parse → policy → schedule connectors → normalize → match → score → risk → persist → notify → periodic refresh. **[DONE]** (logic shared with lifecycle worker, ADR-017)
- **WF-2** Opportunity Execution Workflow: reverify → recalc → risk → prepare negotiation → request approval → wait for signal (bounded) → execute on approve; reject/timeout no-op. **[DONE]** verified on time-skipping server (ADR-021).
- **WF-3** Settlement Workflow: durable milestone-evidence waits + release waits. **[PARTIAL]** (release decision + execution exist synchronously via API; durable Temporal settlement waits TODO — same token drives them, ADR-017/019)

## 12. Settlement & escrow (§19, §20)

- **ST-1** Rail-neutral `SettlementRail` interface + `SettlementService` registry; transactions never coupled to one rail. **[DONE]** (ADR-010)
- **ST-2** Fiat rail on Stripe test mode (simulated with no key; manual-capture PaymentIntent = authorize, capture = release). **[DONE]**
- **ST-3** Stablecoin rail (configurable asset/network, deterministic simulation). **[DONE]**
- **ST-4** Programmable-chain adapter: milestone state, release authorization, multi-recipient split, event emission, dispute/freeze, refund — local/testnet reference. **[DONE]** (in-memory reference; on-chain contract needs audit, ADR-011)
- **ST-5** Progressive settlement state machine (DRAFT→…→SETTLED with DISPUTED/FROZEN), every transition policy-checked + audited. **[DONE]** (`domain`)
- **ST-6** **Escrow condition engine**: versioned AND/OR predicate DSL; pure evaluator is the sole authority for MILESTONE_VERIFIED; minimum trust tier per leaf. **[DONE]** (ADR-029)
- **ST-7** **Evidence ledger**: append-only, hash-chained per entity; verifier + trust tier + predicate recorded; `verifyEvidenceChain`. **[DONE]**
- **ST-8** **Verifier adapters**: pluggable `EvidenceVerifier`; local attestation + deterministic e-signature references; production carrier/e-sign/oracle verifiers implement the same shape. **[DONE]**
- **ST-9** **Release policy**: auto-release below threshold, human dual-control above (approval token bound via `hashReleaseTerms`), optimistic window, deadman auto-refund. **[DONE]** decision; effects now execute (ST-11) — deadman/optimistic windows themselves are still not persisted (ST-13).
- **ST-10** **Rail execution on release**: prepare at fund, execute at release, `provider_ref` + `external_transaction_ref` persisted; execute refuses empty token hash; rail failure aborts DB release. **[DONE]** (ADR-030)
- **ST-11** Refund/dispute execution: wire `auto_refund`/`hold` to rail refund + DISPUTED/FROZEN ops. **[DONE]** (ADR-031: REFUNDED terminal status + migration 0011; `disputeMilestone`/`freezeSettlementPlan`/`refundMilestone` repos; `POST /settlement/milestones/:id/{dispute,refund}` + `POST /settlement/plans/:id/freeze`; `release()` reads real disputed state and executes refund on `auto_refund`. Automatic deadman-triggered refund still needs ST-13's persisted timestamps.)
- **ST-12** Multi-party splits: populate `recipients` + execute multi-recipient payout. **[TODO]**
- **ST-13** Async provider status reconciliation (outbox-driven) + idempotent execute for production rails. **[TODO]**
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
- **UI-4** Milestone/release UI (fund, submit evidence, view ledger, release). **[TODO]**

## 16. API surface (§16)

- **API-1** Missions CRUD + pause/resume/archive + opportunities. **[DONE]**
- **API-2** Opportunities list/detail/reverify/prepare-negotiation/record-outcome. **[DONE]**
- **API-3** Approvals list/detail/approve/reject/modify. **[DONE]**
- **API-4** Transactions detail/settlement-plan/timeline/propose. **[DONE]**
- **API-5** Settlement: fund plan, submit evidence, evidence ledger, release. **[DONE]**
- **API-6** Signals intake; entities/graph intelligence read. **[DONE]**
- **API-7** Webhooks: stripe/telegram/chain. **[PARTIAL]** (routes exist; provider-verified handlers TODO)
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
- **Phase 3** Native Money Rails — exit: a release moves funds on a selected rail behind the escrow engine + evidence ledger + release policy — **CORE MET (ST-1..ST-11, ST-14);** open: splits (ST-12), reconciliation (ST-13), durable settlement waits (WF-3), release UI (UI-4).
- **Phase 4** Public Demand Marketplace — exit: polished operator/user surface with sharing + steering. **PARTIAL** (screens scaffolded).
- **Phase 5** Learning & Scale — exit: outcome-driven calibration + search/graph scale + increased policy-bounded automation. **TODO.**

## 21. Open requirement backlog (net-new, ordered)

1. ST-12 Multi-party splits.
2. ST-13 + WF-3 Async reconciliation + durable settlement waits; persist optimistic/deadman (unblocks automatic deadman-triggered refund via ST-11's now-wired execution path).
3. UI-4 + UI-1/2/3 polish: milestone/release UI, sharing permissions, agent steering.
4. R-4/R-5 Financial per-day accounting + full anti-gaming detectors.
5. OB-1/OB-2 Telemetry surface + operator dashboards.
6. G-5 Graph analytics at scale; SC/Phase-5 outcome-driven score calibration + connector-yield optimization; search index.
7. AZ-1 Supabase JWT production auth; API-7 verified webhooks; API-9 generated client.
8. DE-1/2/3 Infra hardening + retention + AWS templates.
