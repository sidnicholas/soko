# AIOOS — §31 Inspection Report & Vertical-Slice Plan

**Date:** 2026-10-03 · **Against:** `Opportunity_OS_AIOOS_Master_Prompt.md` (the extended PRD) · **Codebase at:** `799709c`

The master prompt's §31 asks for this report before any coding: what exists, what can be reused, what is missing, what should be modified, what should not change — then the smallest vertical slice that proves the loop:

> Internet signal → demand/supply detection → opposite-side discovery → verification → economics → monetization test → contact path → human action

## Headline findings

1. **No real LLM is wired in.** `packages/llm-gateway` routes every task class to `EchoProvider` (a deterministic stub); only embeddings have a real (OpenAI) provider. The "LLM" demand parser and negotiation drafting have only ever run their heuristic/template fallbacks, and production has no model key. Every reasoning step in the PRD (signal extraction, monetization test, outreach) needs a real provider first.
2. **No general internet search.** Sensors today are marketplace connectors (Reverb live, eBay ready but unconfigured) plus inbound signals (SMS/Telegram/WhatsApp/email webhooks). There is no `search(query, filters, source_type)` abstraction and no web-search provider.
3. **The matching/graph/approval/settlement backbone is strong and reusable.** Demand→supply discovery, all-demand×all-supply synthesis, entity graph with cross-entity arbitrage, versioned deterministic scoring, approval-token-gated outbound messaging, hash-chained audit, scheduled cron workers — all exist and fit the PRD's loop.
4. **The PRD's distinctive layers are absent:** verification ladder, "Why do we get paid?" test, economics ranges, expected-value ranking, contactability, provenance labels (fact/inference/estimate/unknown), action-queue buckets, search budgeting, source registry/yield, learning from outcomes.

## A. What already exists (mapped to PRD sections)

| PRD § | Existing | State |
|---|---|---|
| 2 Internet intelligence | Connector SDK (`HttpApi`/crawl adapters, automation-permission gate), Reverb + eBay connectors, inbound messaging signals | Partial — marketplaces only, no web search |
| 3 Source discovery | `ConnectorRegistry` in code | Missing — no DB registry, no yield |
| 4 Cast broadly / intent language | Per-mission search terms (`worker-connectors/queries.ts`) | Minimal — no intent-language queries |
| 5 Demand-first | `runDiscoveryCycle` (mission demand → supply), demand parser | Exists (user-entered demand only) |
| 6 Reverse matching | `synthesizeOpportunities` (all open demand × all supply), signals of `kind: supply` | Partial — no "who needs this?" search |
| 7 Cross-market | Graph `ARBITRAGE`/`SUBSTITUTE_OF`/`BUNDLE` edges, cross-source synthesis | Partial — supply↔supply price gaps only |
| 8 Services as supply | — | Missing |
| 9 Verification | Supply staleness, injection gate, `source_reliability` | Minimal — no status ladder |
| 10 Entity resolution | `entities`/`entity_members` (product-level canonical keys); `counterparties` table unused | Partial — no party/org resolution |
| 11 Freshness/decay | `SUPPLY_STALE_MINUTES`, opportunity `expires_at`, demand `needed_by` expiry | Partial — no decay score |
| 12 Economics | `scoring` economics → single `expected_net_profit` | Partial — no ranges, few cost lines |
| 13 Why-paid test | — | Missing |
| 14 Regulatory | `risk.CATEGORY_POLICY` (allowed / review / prohibited) | Partial — no licensing flags |
| 15 Fraud | Injection detection, anti-gaming scaffolding | Minimal — no scam signals |
| 16 Contactability | — | Missing |
| 17 Outreach | Negotiation drafting (template fallback) + approval-gated `POST /negotiations/:id/send` over SMS/Telegram/WhatsApp/email | Exists — good reuse |
| 18–19 Scoring / EV | Versioned deterministic score with match rationale | Partial — not EV, no ranges, no invalidators |
| 20 Portfolio | — | Missing |
| 21 Progressive depth | — | Missing |
| 22 Search budgeting | LLM cost telemetry in gateway | Minimal — no ledger |
| 23 Query expansion | — | Missing |
| 24–25 Learning | `outcomes` table (captured, unused) | Minimal |
| 26 Action queue | Opportunities list by score; approvals inbox | Partial — no buckets/reason codes |
| 27 Continuous operation | `worker-lifecycle`/`worker-connectors` as 15-min Railway cron jobs | Exists |
| 28 Alerts | Notifications worker (approval delivery only; not deployed) | Minimal |
| 29 Provenance | Observations keep `uri`/`captured_at`/`content_hash`; signals keep `raw_json`; hash-chained evidence ledger (escrow) | Partial — no per-claim fact/inference labels |
| — beyond PRD | Approval tokens, no-self-authorized-money invariant, audit chain, Stripe/Circle rails, RLS, Supabase auth | Strong |

## B. What can be reused

- **Signals table + `SignalsService.submit`** — the universal sink for anything a sensor finds (already risk-gated, projects into supply/demand).
- **Discovery, synthesis, entity graph** — opposite-side matching once both sides are in the DB.
- **Demand parser** — structured extraction (budget, timing, category); becomes LLM-backed once a model exists.
- **Negotiation drafting + approval-gated send** — the outreach step, unchanged in its human gate.
- **LLM gateway** — routing, budgets, cost telemetry, untrusted-content fencing; needs a real provider.
- **Connector SDK `makeHttpApiConnector`** — the pattern for search providers.
- **Cron workers, outcomes table, timeline, audit/evidence ledgers.**

## C. What is missing

Web-search abstraction + provider(s); LLM text provider; intent-signal extraction from search results; source registry with yield; verification ladder; party-level entity resolution + contactability; freshness/decay score; economics ranges; why-paid test; regulatory licensing flags; fraud signals; expected-value ranking with explanations and invalidators; action-queue buckets with reason codes; search budget ledger; bounded query expansion; failure/success learning; alert thresholds; Rapid Opportunity Mode profile ($6,000 experimental target, portfolio view); services-as-supply catalog.

## D. What should be modified

- **Opportunity model**: add verification status, monetization (payer, mechanism, timing, or "monetization unresolved"), economics ranges, EV range + confidence, action bucket, reject reason code, provenance-labelled evidence.
- **Scoring**: add an EV-based v2 alongside the existing deterministic score — same principle (LLM estimates inputs, code computes), with per-factor explanations and "what would invalidate this".
- **`worker-connectors`** → generic sensor sweep (search providers + marketplaces) with a per-run budget cap.
- **Opportunities page** → action queue (ACT NOW / VERIFY NEXT / WATCH / REJECTED).
- **Outcomes** → failure/success reason codes from the PRD's lists.

## E. What should NOT change

- Human approval + approval tokens before any outbound message, commitment, purchase or fund movement (PRD §17, §27 agree).
- Deterministic, versioned final scoring — LLMs estimate, code decides (PRD §18 "explainable" agrees).
- Hash-chained audit/evidence, transactional outbox, risk/injection gates, settlement rails, auth/RLS.
- "Sources are sensors, not the product" — already the connector-registry design.

## Proposed smallest vertical slice

One scheduled loop, end to end, with a hard daily spend cap:

1. **Sense** — `SearchProvider` interface (provider-agnostic), first provider Brave; plus existing Reverb/eBay. Stage-1 queries combine intent language from §4 ("WTB", "RFQ", "surplus", "can't find", …) with categories, a few dozen per run.
2. **Detect** — LLM extracts a structured signal per result: demand / supply / business problem; item, spec, quantity, location, deadline, post date, contact path — each field labelled source fact / inference / unknown, with source URL and the query that found it → `signals`.
3. **Opposite side** — for credible signals, 2–3 bounded opposite-side queries (search + marketplaces); also match against a **services catalog** (the user's own skills: GA4/GTM, WordPress/Divi, research, sourcing…) — services are supply (§8) and give the clearest compensation path.
4. **Verify** — freshness from post date, re-fetch that the source is still live, dedupe by content/entity, status ladder (Verified → Rejected).
5. **Economics + why-paid** — deterministic ranges; LLM proposes payer + mechanism; code rule: no named payer and mechanism → "Potential match — monetization unresolved", which can never reach ACT NOW. Keyword/category regulatory flags (freight broker, real estate, securities, employment agency…).
6. **Contact path** — the public channel found in the source (marketplace messaging, business email, contact form).
7. **Human action** — Action Queue page: buckets, evidence with links and timestamps, EV range with explanation, risks, suggested outreach (existing drafting), send only through the existing approval gate.
8. **Budget ledger** — per-run search + LLM cost; "cost per actionable opportunity" from day one.

Deferred until the slice shows real signal: automated source discovery, learning feedback (reason codes are recorded from the start), alerts, portfolio optimizer, gated networks (Facebook etc. — compliant access only).

## Provider evaluation (current pricing, 2026)

| Option | Fit | Cost / limits |
|---|---|---|
| Brave Search API | Stage-1 broad discovery, general web index | $5 per 1,000 requests; $5 monthly credit (~1,000 queries); payment method required |
| Exa | Semantic "find pages like this need" search, better for intent | $7 per 1,000 requests (10 results incl.); Deep $12–15 per 1,000 |
| SAM.gov Opportunities API | US federal RFQs / sources-sought (real demand) | Free key; 40 calls/day until approved (1,000/day after approval) |
| Reddit Data API | Public intent discussions | Free tier is non-commercial only; commercial use needs a hand-reviewed contract — **not usable for this without one** |
| Firecrawl / Apify / Playwright / Crawlee | Page fetch/extraction | Use only for permitted fetches (robots/ToS respected); not needed for the slice |

## Built — vertical slice v1 (2026-10-03)

Decisions (user): build the slice as proposed; Claude for reasoning; Brave for search; **$1/day hard cap**.

| Step | Where | Notes |
|---|---|---|
| LLM provider | `packages/llm-gateway/src/anthropic.ts` | Official `@anthropic-ai/sdk`. `extraction`/`classification`/`summarization` → `ANTHROPIC_FAST_MODEL` (default `claude-haiku-4-5`); reasoning task classes → `ANTHROPIC_REASONING_MODEL` (default `claude-sonnet-5-5`, effort `low`, server-side refusal fallback `"default"`). Cost priced from `usage` by the serving model. Echo-only without a key, so dev/CI stay keyless. The existing demand parser and negotiation drafting now use Claude too once the key is set. |
| Search abstraction | `packages/connectors-sdk/src/search.ts` | `SearchProvider.search({query, count, freshness})`; Brave first (`BRAVE_SEARCH_API_KEY`), snippets only — no page fetching, so no robots/ToS exposure. |
| Pipeline | `packages/intel` | `stageOneQueries` (intent language × environments, rotated per run, demand/supply/problem lanes) → Haiku detection with fact/inference/unknown labels → bounded opposite-side searches (2/lead) or the services catalog for problem leads → Sonnet assessment (match, economics ranges, payer/mechanism, regulatory/fraud, contact, invalidators, outreach) → deterministic `rules.ts` (verification ladder, freshness decay, keyword regulatory/fraud screens, why-paid gate, EV range, explainable 0–100 score, bucket + reject reason codes). |
| Budget | `SpendBudget` + `intel_runs` | Every paid call is checked against today's remaining allowance (`INTEL_DAILY_BUDGET_USD`) before it runs; actual cost recorded after. Pages already seen cost no model call. |
| Storage | migration `0019_intel.sql` | `intel_runs` (spend ledger), `intel_sources` (registry + yield), `intel_leads` (provenance: URL, query, timestamps, labelled facts), `intel_candidates` (verification, economics, monetization, flags, EV, score explanation, outreach, bucket, user outcome). |
| Worker | `apps/worker-intel` | Runs once and exits (cron). No-op without both keys. |
| API | `apps/api/src/intel` | `GET /intel/queue` (ACT NOW ≤3, VERIFY NEXT ≤15, WATCH, REJECTED, stats, $6,000 portfolio view, sources), `GET /intel/candidates/:id`, `POST /intel/candidates/:id/status` (contacted/responded/won/lost/dismissed + §24/§25 reason codes + realized $). Operator/admin only. |
| UI | `apps/web/src/app/queue` | Action Queue page: evidence with links and timestamps, why-paid, economics, contact path, risks, per-factor score, invalidators, copyable outreach (sent manually — nothing goes out automatically), outcome buttons, source yield. |

Rules worth knowing: "verified" needs a dated, fresh source **and** a contact path read from the source, not just the model's say-so; no named payer + mechanism + value-add means EV $0 and at best WATCH ("Potential match — monetization unresolved"); ACT NOW also requires freshness ≥ 0.5, no regulatory or fraud flags, and capital ≤ $100 (Rapid Opportunity Mode).

Not yet built (next, once the slice shows signal): learning weights from recorded outcomes, alerts, automated source discovery beyond host registration, page re-fetch verification (needs robots-respecting fetch), party-level entity resolution, SAM.gov as a demand sensor.

### Follow-ups (2026-10-03)
- **Carry-over assessment**: the assessment pool is this run's leads plus the best still-unassessed leads from the last 7 days (`listUnassessedIntelLeads`), ranked by credibility × urgency × freshness; leads decayed below freshness 0.1 are retired as `skipped` instead of paid for.
- **Budget pacing**: run *k* of the UTC day may spend up to *k* × (daily cap ÷ `INTEL_RUNS_PER_DAY`) minus what today's earlier runs spent (`runAllowanceUsd`), so the first run can't starve the last and unused share rolls forward. `INTEL_RUNS_PER_DAY` (default 4) must match the cron.
- **Query yield**: `GET /intel/queue` returns per-query runs / results / new / leads / assessed / actionable (`listIntelQueryYield`, from run notes + leads); shown as a table on the Action Queue page.

### First live runs and query rework (2026-10-03)
- 12:00 UTC run: 5 searches, 3 Haiku replies all unparseable (text after the JSON; a price as `"$6,500"`); failed calls were billed but missing from the ledger. Fixed in `5d5a331` (first-complete-JSON extraction, lenient numbers, one retry, every attempt billed via `StructuredOutputError`).
- 13:15 UTC one-off run: parsing clean, $0.029 total (search $0.025, Haiku ~$0.002/call), but 0 leads: 3 of 5 queries returned nothing (stacked exact phrases + recency window) and the 19 open-web results were articles/product pages/directories.
- Query pool rebuilt around venues where intent is written down — `site:` host filters on reddit.com, sam.gov, govdeals.com, liquidation.com, wordpress.org, community.shopify.com (host-level only; path filters aren't documented for Brave). At most one quoted phrase; month windows. Still snippets only — nothing is fetched or scraped.
- Detection now returns a reason for every skipped result (`article`, `product_page`, `directory`, `ad`, `news`, `too_old`, `not_specific`, `not_relevant`, `other`; plus `low_credibility` recorded by the pipeline); the query-yield table shows the top reasons per query.
- Rotation bug fixed: each lane advances by the number of picks it gets per run (a lane whose size equals the per-run count used to repeat every run).
- `INTEL_QUERIES_PER_RUN` set to 8 on `worker-intel` (it was 5).
- 18:00 UTC run (venue queries live): $0.224 (14 searches, 8 LLM calls). 3 leads, all sam.gov "sources sought" notices; all 3 assessments lost because Sonnet wrote `user_compensation_usd` as null / a single number. Assessment schema now normalizes ranges (number → [n, n]; null compensation → [0, 0], null time → [40, 120], null capital → $1,000 — conservative defaults that keep unknowns out of ACT NOW). Measured: one Sonnet assessment ≈ $0.025 (≈ $0.035 with its two opposite-side searches). Reddit/Liquidation quoted queries returned 0 results → unquoted; wordpress.org returned plugin pages → WordPress problems moved to reddit.
- 00:00 UTC run (2026-10-04): budget_exhausted at $0.20 with nothing stored — 4 replies off-spec in four different fields (free-text contact channel, numeric fact value, capital as a range, regulatory flags as strings), each retried and billed twice. Moved to **Anthropic structured outputs** (`output_config.format` via the SDK's `zodOutputFormat`, wire schemas in `zod/v4`): the API guarantees shape and types. The parse layer now also normalizes what structured outputs only hint (enum values), and an off-list monetization mechanism counts as none named. If the API rejects a schema (400) the provider resends once without it.
