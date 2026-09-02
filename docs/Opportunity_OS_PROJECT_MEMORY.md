# Opportunity OS — Project Memory (Implementation State)

**Status:** V1 in active build — Phases 0–2 complete, Phase 3 (Native Money Rails) ~70% built, Phases 4–5 partial.
**Last updated:** 2026-09-02
**HEAD:** `467f7d6` (origin/main, clean)
**Purpose:** Living memory of *what actually exists in the codebase* and *what is next*. This supersedes the original concept-capture memory (`AI_Opportunity_Operating_System_Project_Memory.md`) for engineering purposes. Requirements live in `Opportunity_OS_TECHNICAL_REQUIREMENTS.md`; rationale lives in `docs/adr/`.

---

## 1. What this is

A model-agnostic, demand-first economic coordination platform that continuously discovers lawful unmet demand and underutilized supply, converts them into structured economic objects, matches them, scores economics + risk deterministically, and presents actionable opportunities to a human operator. It is reframing from a "marketplace aggregator" into a **transaction-discovery network + transaction operating system**: opportunities can arise from *any* signal channel (even by connecting two independent facts with no listing), and every completed deal feeds a learning loop.

Human control is preserved over outbound negotiation, binding commitments, purchases, and movement of money. Fiat and blockchain settlement are native architectural capabilities from day one behind one abstraction.

Internal spine:
`Signals → (Entities/Graph) → Supply → Demand → Matches → Opportunities → Negotiations → Transactions → Settlement → Outcomes`

## 2. Repository shape

Monorepo: pnpm workspaces + Turborepo, TypeScript strict, ESM. Node via `.nvmrc`. `DATABASE_URL`-driven Postgres.

- **19 packages** (`packages/*`): `contracts`, `config`, `ids`-in-contracts, `domain`, `audit`, `auth`, `risk`, `scoring`, `demand`, `discovery`, `connectors-sdk`, `verifiers-sdk`, `escrow`, `settlement`, `chain`, `llm-gateway`, `observability`, `db`, `ui`.
- **8 apps** (`apps/*`): `api` (NestJS/Fastify), `web` (Next.js), `worker-outbox`, `worker-connectors`, `worker-lifecycle`, `worker-temporal`, `worker-notifications`, `worker-agents`.
- **10 SQL migrations** (`packages/db/migrations/0001`–`0010`), 22 tables, forward-only idempotent runner.
- **30 ADRs** (`docs/adr/ADR-001`–`030`).
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
| `worker-temporal` | Durable workflows (mission discovery, opportunity execution / approval-wait). | Built (verified against time-skipping test server) |
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

## 4. Event model

36 canonical versioned event names in `EVENT_NAMES` (`contracts/events.ts`), all delivered through the **transactional outbox** so DB state and event publication cannot diverge. Idempotency key per event. Covers mission/demand/supply/match/opportunity/approval/negotiation/transaction/settlement/fulfillment/risk/audit/signal/outcome lifecycles.

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

### Phase 3 — Native Money Rails 🟡 (~70%)
Built:
- Rail-neutral settlement abstraction (`SettlementService` + `SettlementRail`), Stripe fiat rail (test/simulated), stablecoin rail, programmable-chain adapter (local/testnet reference).
- **Escrow condition/release engine** (ADR-029): versioned AND/OR predicate DSL (`shipment_delivered`, `document_signed`, `gps_within_geofence`, `sensor_threshold`, `time_elapsed`, `milestone_attested`, `oracle_true`); pure `evaluateCondition` is the only authority for `MILESTONE_PENDING → MILESTONE_VERIFIED`; `decideRelease` policy (dispute→hold, deadman→auto_refund, auto below threshold, human approval above, optimistic window).
- **Verifier adapters** (`verifiers-sdk`): pluggable `EvidenceVerifier`; keyless local attestation + deterministic e-signature reference verifiers.
- **Evidence ledger**: `evidence` table is append-only + hash-chained per entity; `verifyEvidenceChain` detects tampering.
- **Settlement repos + API**: fund plan, add milestone, submit evidence (verify→ledger→evaluate→verify milestone), release (engine decides auto vs token-gated). Settles the transaction once all milestones release; every hop guarded by the state machine + audit chain.
- **Rail execution** (ADR-030): release actually moves funds — authorize (`prepare`) at fund, capture/settle (`execute`) at release, rail selected by `plan.rail_family`, `provider_ref` + `external_transaction_ref` persisted. `SettlementService.execute` refuses an empty approval-token hash.

Remaining (Phase 3):
1. Refund/dispute execution — wire `decideRelease` `auto_refund`/`hold` to real rail refund + `DISPUTED`/`FROZEN` state operations.
2. Multi-party splits — populate `recipients` and execute multi-recipient payouts (rails already advertise `supportsMultiRecipient`).
3. Persist optimistic/deadman windows on milestones + drive Temporal-durable release waits.
4. Milestone/release UI.

### Phase 4 — Public Demand Marketplace 🟡 (scaffolded)
All 9 required screens exist as Next.js pages (home/search, missions/[id], opportunities, opportunities/[id], approvals, transactions/[id], payments, archive, settings) with a typed API client. Remaining: polish Search/Ask, mission history/archive depth, richer transaction timeline + payments views, sharing permissions, user↔agent steering.

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

`NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `SUPABASE_*`, `REDIS_URL`, `TEMPORAL_*`, `LLM_DEFAULT_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIM`/`EMBEDDING_BACKEND`, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, `DEFAULT_STABLECOIN_NETWORK`, `CHAIN_RPC_URL`, `TELEGRAM_*`/`EMAIL_FROM`/`SMTP_URL`, `APPROVAL_TOKEN_SECRET`, `AUDIT_ANCHOR_ENABLED`, `APPROVAL_TIMEOUT_MINUTES`, `MISSION_REFRESH_INTERVAL_MINUTES`, `SUPPLY_STALE_MINUTES`, `SETTLEMENT_AUTO_RELEASE_THRESHOLD_MINOR`. All validated in `config`; safe defaults let dev/CI run keyless.

## 9. ADR index

001 TS monorepo · 002 Next.js FE · 003 NestJS/Fastify · 004 modular-first · 005 Postgres/Supabase SoR · 006 Temporal durable workflows · 007 transactional outbox · 008 central LLM gateway · 009 policy-enforced human approval · 010 rail-neutral settlement · 011 blockchain for settlement proofs only · 012 hash-chained audit · 013 Railway-first/AWS-portable · 014 permitted/authorized sources only · 015 deterministic final scoring · 016 V1 decision-packet defaults · 017 lifecycle worker drives V1 discovery · 018 demand parser LLM+heuristic · 019 approval tokens + synchronous execution · 020 LLM negotiation drafting · 021 durable approval-wait workflow · 022 signals→outcomes transaction-discovery network · 023 market graph + entity resolution · 024 embeddings + graph edges · 025 embedding provider · 026 pgvector backend · 027 graph-derived opportunities · 028 risk-gated channel adapters · 029 escrow condition/release engine · 030 rail execution.

## 10. Immediate next options

Ordered by leverage on the Transaction-OS thesis:
1. **Refund/dispute execution** — closes the release engine's `auto_refund`/`hold` decisions with real rail refunds + dispute/freeze state ops.
2. **Multi-party splits** — multi-recipient payouts (arbitrage/broker deals need this).
3. **Persist optimistic/deadman + Temporal release waits** — durable, capital-efficient auto-release.
4. **Phase 4 polish** — sharing permissions + user↔agent steering + richer timeline/payments views.
5. **Phase 5 learning loop** — outcome-driven score calibration + connector-yield optimization.
