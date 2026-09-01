# AI Opportunity Operating System — V1 Technical Specification

**Version:** 1.0  
**Status:** Build-ready baseline  
**Date:** August 31, 2026  
**Primary coding agent:** Oh My Pi  
**Initial market:** United States

## 1. Executive Summary

V1 is a model-agnostic, demand-first economic coordination platform that continuously discovers lawful unmet demand and underutilized supply, converts them into structured economic objects, matches them, evaluates economics and risk, and presents actionable opportunities to a human operator.

The first production milestone is not a fully autonomous marketplace. It is a working economic nervous system that automatically creates, refreshes, scores, and presents real opportunities while preserving human control over outbound negotiation, binding commitments, purchases, and movement of money.

Fiat and blockchain settlement are native architectural capabilities from the outset. V1 must expose a unified settlement abstraction even if individual rails are enabled progressively.

## 2. Locked Product Constraints

- Geography: United States.
- Opportunity universe: everything lawful, excluding highly regulated categories initially.
- Available engine capital: $500.
- Capital preference: $0-capital opportunities first.
- Minimum opportunity profit: no hard lower limit; positive expected profit is acceptable.
- Autonomous actions: discovery, collection, normalization, research, classification, scoring, matching, economics, risk assessment, negotiation preparation.
- Human-gated actions: outbound negotiation, binding commitments, purchases, fund movement.
- Approval channels: Telegram first; email fallback/parallel.
- Frontend: React / Next.js.
- Backend: TypeScript, NestJS with Fastify adapter.
- Architecture: modular monolith plus independently deployable workers/services at V1; event-driven boundaries designed for later microservice extraction.
- Workflow engine: Temporal.
- Primary database: PostgreSQL, initially Supabase.
- Cache/ephemeral coordination: Redis.
- Initial deployment: Railway-compatible containers; portable to AWS.
- AI: model-agnostic LLM Gateway.
- Settlement: native fiat + stablecoin/blockchain abstraction.
- Public UX direction: persistent Search/Mission objects and a simple conversational economic command center.
- Anti-gaming and immutable auditability: required from first release.

## 3. V1 Scope

### 3.1 Must Build

1. User authentication and operator role.
2. Search/Mission creation, editing, pausing, archiving, and history.
3. Demand Specification parser.
4. Source Connector interface and at least two permitted/authorized source adapters.
5. Opportunity Collector and normalization pipeline.
6. Supply and demand persistence.
7. Matching engine.
8. Opportunity scoring and economics engine.
9. Availability/lifecycle refresh.
10. Risk, trust, and compliance gating.
11. Opportunity dashboard.
12. Human approval workflow through Telegram and email.
13. Negotiation-draft generation, but no autonomous outbound negotiation.
14. Unified Payment/Settlement Service interfaces.
15. Fiat sandbox integration.
16. Stablecoin/blockchain settlement sandbox/prototype path.
17. Transaction state machine.
18. Immutable application audit log with hash chaining.
19. LLM Gateway.
20. Basic observability and cost telemetry.
21. Public/request intake API designed for later marketplace UI.

### 3.2 Explicitly Not Required for First Production Milestone

- Fully autonomous negotiation.
- Autonomous purchasing.
- Autonomous release of money.
- Full public marketplace catalog.
- A dedicated graph database.
- On-chain storage of private marketplace data.
- Supporting every blockchain.
- Supporting highly regulated goods/services.
- Large-scale crawling of sources that prohibit automated access.
- Native mobile applications.
- Complex reputation tokenomics.
- DAO governance.
- Inventory ownership as a default business model.

## 4. Architecture Principle: Modular First, Microservices Ready

V1 should not deploy twenty tiny network services simply because twenty logical agents exist. That creates operational cost before product-market evidence.

Use a monorepo with strong domain boundaries. Deploy the web/API, workers, Temporal workers, connector workers, and settlement adapter as separate processes where useful. Each domain communicates through typed commands/events so it can later become an independent microservice without rewriting business logic.

### 4.1 Logical Architecture

```text
[Next.js Web / Public Intake]
            |
      [API Gateway/BFF]
            |
  [Identity + Authorization]
            |
 ---------------------------------------------------------
 | Mission | Demand | Supply | Matching | Opportunity    |
 | Risk    | Approval | Transaction | Settlement | Audit |
 ---------------------------------------------------------
            |
      [Domain Event Bus]
            |
 ---------------------------------------------------------
 | Connector Workers | Research Workers | Agent Workers  |
 | Lifecycle Worker  | Temporal Workers | Notifications  |
 ---------------------------------------------------------
            |
 ---------------------------------------------------------
 | PostgreSQL | Redis | Object Storage | Search/Vector   |
 ---------------------------------------------------------
            |
 ---------------------------------------------------------
 | LLM Providers | Stripe | Chain Adapters | Email       |
 | Telegram | Logistics/Data APIs | Permitted Sources    |
 ---------------------------------------------------------
```

## 5. Recommended Repository Structure

```text
opportunity-os/
  apps/
    web/                    # Next.js frontend
    api/                    # NestJS/Fastify API/BFF
    worker-agents/          # AI/research/classification workers
    worker-connectors/      # source ingestion
    worker-lifecycle/       # availability refresh
    worker-temporal/        # durable workflows
    worker-notifications/   # Telegram/email
  packages/
    contracts/              # Zod schemas, commands, events
    db/                     # schema, migrations, repositories
    auth/                   # RBAC/ABAC policies
    domain/                 # domain models/state machines
    scoring/                # opportunity economics/scoring
    llm-gateway/            # provider-independent model routing
    settlement/             # rail-neutral settlement interfaces
    chain/                  # blockchain adapters and proofs
    connectors-sdk/         # standard connector interface
    risk/                   # trust, fraud, anti-gaming rules
    audit/                  # immutable audit primitives
    observability/          # logs, traces, metrics, cost
    ui/                     # shared frontend components
    config/                 # typed environment config
  infra/
    docker/
    railway/
    aws/
    temporal/
    supabase/
  docs/
    adr/                    # architecture decision records
    api/
    threat-model/
    runbooks/
  tests/
    e2e/
    fixtures/
```

Use pnpm workspaces + Turborepo unless Oh My Pi has a compelling compatibility reason to choose Nx.

## 6. Core Domain Model

### 6.1 User
Fields:
- id
- email
- display_name
- role
- trust_tier
- status
- created_at
- updated_at

### 6.2 Mission
Persistent user search/request.

Fields:
- id
- owner_user_id
- title
- raw_intent
- status
- current_version_id
- agent_autonomy_policy
- created_at
- updated_at
- archived_at

### 6.3 MissionVersion
Immutable snapshot of mission constraints.

Fields:
- id
- mission_id
- version_number
- demand_spec_json
- changed_by
- change_reason
- created_at

### 6.4 Demand
Fields:
- id
- mission_id nullable
- source_id
- external_ref
- description
- category
- buyer/counterparty reference
- target_price
- max_budget
- currency
- quality_constraints_json
- needed_by
- urgency_score
- importance_context
- payment_preferences_json
- fulfillment_location
- geo_point
- acceptable_substitutes_json
- non_negotiables_json
- negotiation_limits_json
- confidence
- availability_status
- last_verified_at
- created_at

### 6.5 Supply
Fields:
- id
- source_id
- external_ref
- seller/provider reference
- title
- description
- category
- price
- currency
- quantity/capacity
- condition/quality_json
- location
- geo_point
- fulfillment_options_json
- availability_status
- source_evidence_id
- last_verified_at
- created_at

### 6.6 Match
Fields:
- id
- demand_id
- supply_id
- semantic_score
- constraint_score
- geography_score
- timing_score
- quality_score
- total_match_score
- explanation_json
- created_at

### 6.7 Opportunity
Fields:
- id
- match_id
- status
- transaction_role
- expected_revenue
- expected_direct_cost
- expected_net_profit
- capital_required
- close_probability
- time_to_cash_minutes
- repeatability_score
- payment_certainty_score
- fraud_risk_score
- compliance_risk_score
- operational_friction_score
- customer_value_score
- overall_score
- score_version
- next_action
- last_verified_at
- expires_at
- created_at

### 6.8 Counterparty
Fields:
- id
- type: person|organization
- normalized_name
- source identities
- trust score
- verification level
- risk flags
- transaction statistics
- created_at

Do not merge identities across sources solely from LLM inference. Require deterministic or human-reviewed evidence above a configured threshold.

### 6.9 Approval
Fields:
- id
- requested_by_agent
- action_type
- entity_type
- entity_id
- payload_hash
- human_readable_summary
- risk_summary
- expires_at
- status
- decided_by
- decision
- decision_metadata
- decided_at

### 6.10 Negotiation
Fields:
- id
- opportunity_id
- side
- state
- approved_bounds_json
- draft_messages
- outbound_message_ids
- offers/counteroffers
- created_at

### 6.11 Transaction
Fields:
- id
- opportunity_id
- buyer_id
- seller_id
- status
- terms_version
- terms_hash
- gross_amount
- currency
- platform_revenue
- settlement_plan_id
- fulfillment_plan_id
- created_at

### 6.12 SettlementPlan
Fields:
- id
- transaction_id
- rail_family: fiat|stablecoin|onchain_programmable
- provider
- asset/currency
- total_amount
- status
- human_release_policy
- created_at

### 6.13 SettlementMilestone
Fields:
- id
- settlement_plan_id
- sequence
- name
- amount_or_percentage
- required_evidence_json
- release_conditions_json
- status
- approved_at
- released_at
- external_transaction_ref

### 6.14 Evidence
Fields:
- id
- entity_type
- entity_id
- source
- source_uri/ref
- content_hash
- captured_at
- expires_at
- metadata_json

### 6.15 AuditEvent
Append-only.
Fields:
- id
- actor_type
- actor_id
- action
- entity_type
- entity_id
- input_hash
- output_hash
- policy_version
- model_provider/model/version when applicable
- confidence
- previous_event_hash
- event_hash
- created_at

## 7. Demand Specification Contract

```ts
interface DemandSpecification {
  what: {
    description: string;
    urls?: string[];
    imageRefs?: string[];
    identifiers?: Record<string, string>;
  };
  budget: {
    target?: Money;
    maximum?: Money;
    flexible: boolean;
    includesFees?: boolean;
    includesDelivery?: boolean;
  };
  quality: {
    naturalLanguage?: string;
    constraints: Constraint[];
  };
  timing: {
    neededBy?: string;
    urgency: "immediate" | "today" | "days" | "scheduled" | "flexible";
    recurring?: Recurrence;
  };
  importance?: {
    context?: string;
  };
  payment: {
    acceptableMethods: PaymentMethodFamily[];
  };
  fulfillment: {
    type: "ship" | "pickup" | "onsite" | "digital" | "other";
    location?: GeoLocation;
    radiusMiles?: number;
  };
  flexibility: {
    substitutesAllowed: boolean;
    negotiableFields: string[];
    nonNegotiables: Constraint[];
  };
  negotiationAuthorization: {
    mayPrepare: boolean;
    maySend: boolean; // false by default V1
    maxAmount?: Money;
  };
}
```

## 8. Agent Runtime Contract

Logical agents must use a common envelope.

```ts
interface AgentTask<TInput> {
  taskId: string;
  agentType: AgentType;
  missionId?: string;
  entityRefs: EntityRef[];
  input: TInput;
  policyContext: PolicyContext;
  budget: {
    maxUsd: number;
    maxTokens?: number;
    deadlineMs?: number;
  };
}

interface AgentResult<TOutput> {
  taskId: string;
  status: "completed" | "needs_human" | "failed" | "retry";
  output?: TOutput;
  confidence: number;
  evidenceRefs: string[];
  proposedActions: ProposedAction[];
  costTelemetry: CostTelemetry;
}
```

Agents do not directly mutate money, send negotiations, or create binding commitments. They submit proposed actions through policy enforcement.

## 9. Agent-to-Service Mapping

Logical agents map to domain capabilities:

- Demand/Intent + Buyer Advocate -> Mission/Demand domain + agent workers.
- Collector -> Connector workers.
- Classification -> Agent workers.
- Scoring + Economics -> Scoring package/service.
- Supply/Matching -> Matching domain.
- Research -> Agent workers + connector SDK.
- Risk/Trust + Anti-Gaming -> Risk domain.
- Negotiation -> Negotiation domain + agent worker.
- Transaction/Payment -> Transaction + Settlement domains.
- Logistics -> Fulfillment adapter domain.
- CRM/Follow-up -> Mission/Counterparty domain.
- Portfolio/Mission -> Ranking scheduler.
- Learning/Strategy -> analytics pipeline; limited V1 feedback loop.
- Orchestrator -> Temporal workflows.
- Availability/Lifecycle + Marketplace Lifecycle -> lifecycle worker.
- Approval/Control -> Approval domain + notification worker.

## 10. Event Model

All events must be versioned and idempotent.

Core V1 events:

```text
mission.created.v1
mission.updated.v1
mission.paused.v1
mission.archived.v1
demand.created.v1
demand.verified.v1
demand.expired.v1
supply.discovered.v1
supply.updated.v1
supply.unavailable.v1
match.created.v1
opportunity.qualified.v1
opportunity.score_changed.v1
opportunity.awaiting_approval.v1
approval.requested.v1
approval.approved.v1
approval.rejected.v1
negotiation.draft_ready.v1
negotiation.send_requested.v1
transaction.proposed.v1
transaction.agreed.v1
settlement.plan_created.v1
settlement.funding_required.v1
settlement.milestone_ready.v1
settlement.release_requested.v1
settlement.released.v1
fulfillment.started.v1
fulfillment.completed.v1
transaction.disputed.v1
transaction.settled.v1
transaction.closed.v1
risk.flagged.v1
audit.integrity_failed.v1
```

Use the transactional outbox pattern so database changes and event publication cannot diverge.

## 11. Temporal Workflows

### 11.1 Mission Discovery Workflow
1. Parse mission.
2. Validate policy/category.
3. Schedule connectors.
4. Normalize supply/demand candidates.
5. Match.
6. Score.
7. Risk check.
8. Persist opportunities.
9. Notify operator/user if threshold met.
10. Continue periodic refresh until paused/expired/fulfilled.

### 11.2 Opportunity Execution Workflow
1. Reverify demand and supply.
2. Recalculate economics.
3. Risk/compliance check.
4. Prepare negotiation.
5. Request human approval.
6. Wait for approval signal.
7. If approved, send approved outbound action through adapter.
8. Track response.
9. Re-enter approval for changed terms outside bounds.
10. When agreement exists, create proposed transaction.
11. Require commitment/funding approval.
12. Start fulfillment and settlement workflow.

### 11.3 Settlement Workflow
1. Create settlement plan.
2. Select configured rail.
3. Obtain required funding authorization.
4. Confirm funding.
5. Wait for milestone evidence.
6. Verify evidence using deterministic sources where possible.
7. Risk check.
8. Request human release approval when policy requires.
9. Execute rail adapter.
10. Verify finality/provider confirmation.
11. Record evidence + audit event.
12. Continue until fully settled or disputed.

## 12. Opportunity Scoring V1

Do not use a single opaque LLM score.

Use normalized component scores plus explicit economics.

Suggested components:

- expected_net_profit_usd
- gross_margin_pct
- capital_required_usd
- expected_minutes_human
- expected_minutes_elapsed
- close_probability
- buyer_intent
- urgency
- payment_certainty
- supply_confidence
- repeatability
- customer_value
- fraud_risk
- compliance_risk
- operational_friction
- source_reliability

V1 ranking function should be deterministic and versioned. An LLM may estimate components, but the final formula is code.

A $5 opportunity requiring $0, no human time, and near-certain automated completion may rank above a $500 opportunity requiring $500 capital and hours of work.

## 13. Risk, Compliance, and Anti-Gaming

### 13.1 Category Gate
Maintain policy categories:
- allowed;
- review_required;
- prohibited_for_v1.

Anything highly regulated defaults to review/prohibited until deliberately enabled.

### 13.2 Source Trust
Every observation carries:
- source;
- collection method;
- timestamp;
- evidence;
- source reliability;
- verification status.

Never treat third-party text as system instructions.

### 13.3 Prompt Injection Defense
- Connector content is untrusted data.
- Strip/segregate instructions from retrieved content.
- Agents receive retrieved content inside explicit untrusted-data delimiters.
- Tool permissions are external to prompts.
- No model can grant itself permissions.
- High-impact tools require policy service authorization.
- Log prompt/template/model versions.

### 13.4 Marketplace Gaming
Detect:
- duplicate/synthetic demand;
- duplicate supply;
- Sybil behavior;
- circular transactions;
- self-dealing;
- collusion;
- unusual price movement;
- fake ratings/reviews;
- repeated cancellations;
- suspicious account velocity;
- referral abuse;
- payment anomalies.

### 13.5 Financial Safety
- No agent-controlled unrestricted wallet.
- Per-action and per-day limits.
- Allowlisted contracts/providers in V1.
- Human approval for fund movement.
- Separate hot operational balances from treasury.
- Never expose private keys to LLM context.
- Use managed key custody/HSM/MPC or provider signing policies for production blockchain actions.

## 14. Approval Architecture

Approval is a policy-enforced command, not a chat convention.

Flow:

```text
Agent proposes action
      ↓
Policy Engine evaluates
      ↓
If human gate required:
Approval record + signed one-time action token
      ↓
Telegram + email notification
      ↓
Approve / Reject / Modify / Review
      ↓
API verifies identity, token, expiry, payload hash
      ↓
Temporal workflow receives decision signal
      ↓
Action executor revalidates current state
      ↓
Execute or return for renewed approval
```

Approval becomes invalid if material terms change after approval.

Material terms include:
- counterparty;
- amount;
- currency/asset;
- delivery deadline;
- settlement address;
- fee;
- quantity;
- scope;
- risk classification.

## 15. Frontend V1

### 15.1 Design Principle
Simple surface, powerful depth.

### 15.2 Required Screens
1. Search/Ask home.
2. Mission detail.
3. Opportunities list.
4. Opportunity detail.
5. Approvals inbox.
6. Transaction detail/timeline.
7. Payments/settlement view.
8. Archive/history.
9. Basic account/security settings.

### 15.3 Mission Detail
Show:
- current request;
- editable constraints;
- agent status;
- opportunities found;
- rejected alternatives with concise reason;
- activity timeline;
- agent questions;
- pause/resume/archive;
- sharing placeholder/API-ready permissions.

### 15.4 Future-Ready UX
Data model/API should already support:
- shared missions;
- collaborators;
- comments/chat;
- sales as well as purchases;
- user-to-agent steering;
- transaction history;
- reusable searches;
- recurring missions.

## 16. API Surface V1

Representative endpoints:

```text
POST   /v1/missions
GET    /v1/missions
GET    /v1/missions/:id
PATCH  /v1/missions/:id
POST   /v1/missions/:id/pause
POST   /v1/missions/:id/resume
POST   /v1/missions/:id/archive
GET    /v1/missions/:id/opportunities

GET    /v1/opportunities
GET    /v1/opportunities/:id
POST   /v1/opportunities/:id/reverify
POST   /v1/opportunities/:id/prepare-negotiation

GET    /v1/approvals
GET    /v1/approvals/:id
POST   /v1/approvals/:id/approve
POST   /v1/approvals/:id/reject
POST   /v1/approvals/:id/modify

GET    /v1/transactions/:id
POST   /v1/transactions/:id/settlement-plan
GET    /v1/transactions/:id/timeline

POST   /v1/webhooks/stripe
POST   /v1/webhooks/telegram
POST   /v1/webhooks/chain/:network

POST   /v1/public/requests
```

Use OpenAPI generation from NestJS and generate a typed frontend client.

## 17. Source Connector SDK

Every source adapter implements:

```ts
interface SourceConnector {
  id: string;
  capabilities: ("demand" | "supply" | "availability" | "pricing")[];
  policy: ConnectorPolicy;

  search(input: ConnectorSearch): Promise<RawObservation[]>;
  fetch(ref: ExternalRef): Promise<RawObservation>;
  verify?(ref: ExternalRef): Promise<VerificationResult>;
}
```

Connector metadata must include whether automation is:
- official API;
- licensed feed;
- authorized user connection;
- permitted public fetch;
- manual/human-assisted.

Do not build V1 around prohibited scraping.

## 18. LLM Gateway

Required capabilities:
- provider routing;
- task profiles;
- fallback;
- structured outputs;
- per-task budgets;
- timeout;
- retries;
- redaction;
- model/version logging;
- token/cost accounting;
- caching where safe;
- evaluation hooks.

Task classes:
- extraction;
- classification;
- summarization;
- matching explanation;
- research synthesis;
- negotiation drafting;
- risk reasoning.

High-volume extraction/classification should prefer inexpensive models. Complex/high-value reasoning can use stronger models.

## 19. Settlement Architecture

Settlement is native from day one.

```ts
interface SettlementRail {
  railId: string;
  family: "fiat" | "stablecoin" | "onchain_programmable";
  capabilities(): RailCapabilities;
  quote(plan: SettlementPlan): Promise<SettlementQuote>;
  prepare(plan: SettlementPlan): Promise<PreparedSettlement>;
  execute(approved: ApprovedSettlement): Promise<ExecutionResult>;
  status(ref: string): Promise<SettlementStatus>;
  refund?(...): Promise<RefundResult>;
}
```

### 19.1 Fiat Rail
Initial provider: Stripe sandbox/test mode.

Use marketplace-capable primitives where appropriate, but legal/payment-flow design must be reviewed before production launch. Do not market platform-held funds as legal “escrow” unless the implemented provider/legal structure permits that characterization.

### 19.2 Stablecoin Rail
Expose stablecoin as a native rail through supported provider capabilities. Keep stablecoin asset/network support configurable.

### 19.3 Programmable Blockchain Rail
Build an adapter and local/testnet reference implementation for:
- milestone state;
- release authorization;
- multi-recipient split;
- event emission;
- dispute/freeze state;
- refund/cancel path where contract design permits.

Production smart contracts require dedicated security review/audit before meaningful funds are used.

### 19.4 Off-Chain / On-Chain Split
Off-chain:
- PII;
- addresses;
- private commercial terms;
- messages;
- detailed evidence;
- agent reasoning.

On-chain when useful:
- transaction identifier/hash;
- terms hash;
- milestone hash;
- approval/release attestation;
- settlement transaction;
- final state proof.

## 20. Progressive Settlement State Machine

```text
DRAFT
  ↓
AWAITING_FUNDING_APPROVAL
  ↓
FUNDING_PENDING
  ↓
FUNDED
  ↓
MILESTONE_PENDING
  ↓
MILESTONE_VERIFIED
  ↓
AWAITING_RELEASE_APPROVAL
  ↓
RELEASE_PENDING
  ↓
PARTIALLY_SETTLED
  ↘
   DISPUTED / FROZEN
  ↓
SETTLED
```

Each transition requires a policy check and audit event.

## 21. Audit Integrity

V1 uses append-only audit records plus hash chaining.

For each event:

```text
event_hash = HASH(
  previous_event_hash
  + canonical_event_payload
)
```

Periodically anchor a batch/root hash to an external immutable system or blockchain. This provides tamper evidence without placing private data on-chain.

## 22. Authentication and Authorization

Use Supabase Auth initially, but domain authorization remains application-owned.

Roles:
- user;
- operator;
- reviewer;
- admin;
- service;
- agent.

Use RBAC plus attribute/policy checks.

Examples:
- an agent can create an ApprovalRequest but cannot approve it;
- a notification worker can deliver approval links but cannot execute settlement;
- a settlement executor requires an approved command with matching payload hash;
- a user can edit their mission but cannot mutate prior MissionVersion records.

Enable PostgreSQL Row Level Security for user-facing tables.

## 23. Data Privacy

- Minimize PII collection.
- Encrypt sensitive data at rest/provider level.
- Secrets only in secret managers/environment injection.
- Never store payment credentials directly.
- Never put PII on-chain.
- Define retention policies for source observations and evidence.
- Allow user mission archival and later deletion subject to transaction/legal retention obligations.
- Separate analytical/training use from operational data permissions.

## 24. Deployment

### V1
- Railway: web/API/workers as containers.
- Railway private networking for internal services.
- Supabase managed Postgres/Auth/Storage/Edge where appropriate.
- Managed Redis.
- Temporal Cloud or self-hosted Temporal based on cost/operational evaluation.
- Object storage via Supabase Storage initially or S3-compatible provider.

### Portability
All business services ship as OCI containers.
Avoid Railway-specific business logic.
Infrastructure definitions live under `/infra`.
Create AWS target templates early but do not deploy AWS complexity until justified.

### AWS Scale Target
- ECS/Fargate;
- EventBridge/SQS where appropriate;
- Aurora/RDS Postgres;
- ElastiCache;
- S3;
- CloudFront/WAF;
- KMS/Secrets Manager;
- OpenSearch.

## 25. Observability

Required from V1:
- structured JSON logs;
- trace/correlation ID;
- mission ID;
- opportunity ID;
- workflow ID;
- agent task ID;
- model/provider/version;
- LLM cost;
- connector cost;
- settlement provider reference;
- error classification;
- latency;
- retry count.

Dashboards:
- opportunities discovered/hour;
- qualified opportunity rate;
- expected profit pipeline;
- realized profit;
- close rate;
- time-to-first-opportunity;
- time-to-cash;
- capital deployed;
- ROI on deployed capital;
- human approval latency;
- false-positive rate;
- connector yield;
- LLM spend/opportunity;
- fraud/risk flags.

## 26. Testing Strategy

### Unit
- scoring;
- economics;
- state transitions;
- policy rules;
- settlement calculations;
- hash/audit logic.

### Contract
- connectors;
- LLM providers;
- payment rails;
- blockchain adapters;
- Telegram/email adapters.

### Integration
- Postgres/outbox/events;
- Temporal workflows;
- approval signals;
- Stripe test mode;
- chain testnet/local chain.

### End-to-End Golden Path
1. User creates mission.
2. Connector finds candidate supply.
3. Demand/supply normalize.
4. Match created.
5. Opportunity scored.
6. Risk passes.
7. Negotiation draft generated.
8. Telegram approval sent.
9. Operator approves.
10. Approved outbound action is simulated/test-adapter in CI.
11. Transaction proposed.
12. Settlement plan created.
13. Test funding occurs.
14. Milestone evidence submitted.
15. Release approval requested.
16. Test settlement executes.
17. Audit chain validates.
18. Transaction closes.

## 27. Build Phases

### Phase 0 — Foundation
- Monorepo.
- CI.
- typed config.
- Postgres/Supabase.
- auth.
- migrations.
- domain contracts.
- audit log.
- Temporal.
- Redis.
- observability.

### Phase 1 — Economic Nervous System
- Mission CRUD/versioning.
- Demand parser.
- Connector SDK.
- first permitted connectors.
- normalization.
- supply/demand persistence.
- matching.
- deterministic scoring/economics.
- lifecycle refresh.
- operator opportunity dashboard.

**Exit criterion:** real or test-source opportunities automatically enter the database, match, score, refresh, and appear without manual hunting.

### Phase 2 — Human-Controlled Execution
- negotiation drafting;
- approval service;
- Telegram;
- email;
- Temporal approval waits;
- transaction proposal;
- audit-backed action execution.

### Phase 3 — Native Money Rails
- Stripe test integration;
- settlement abstraction;
- stablecoin provider path;
- programmable settlement local/testnet implementation;
- milestone/release UI;
- multi-party splits;
- evidence and release approvals.

### Phase 4 — Public Demand Marketplace
- polished Search/Ask interface;
- mission history/archive;
- user opportunity views;
- transaction timeline;
- payments view;
- sharing permissions;
- agent steering.

### Phase 5 — Learning and Scale
- performance feedback;
- score calibration;
- source yield optimization;
- search index;
- graph analytics;
- increased automation under policy;
- AWS migration only where justified.

## 28. First Sprint Backlog for Oh My Pi

1. Initialize pnpm/Turborepo TypeScript monorepo.
2. Create Next.js web app.
3. Create NestJS API using Fastify adapter.
4. Add shared Zod contracts.
5. Configure Supabase local/dev project and migrations.
6. Implement User, Mission, MissionVersion, Demand, Supply, Match, Opportunity, Evidence, AuditEvent.
7. Add Row Level Security policies.
8. Implement append-only audit writer and hash-chain verifier.
9. Configure Temporal and first MissionDiscovery workflow.
10. Implement SourceConnector SDK plus `fixture` connector.
11. Implement normalization pipeline.
12. Implement deterministic matcher.
13. Implement scoring/economics package.
14. Build mission creation UI.
15. Build opportunity list/detail UI.
16. Implement approval domain.
17. Add Telegram adapter with signed approval links/actions.
18. Add email adapter.
19. Add Stripe test adapter behind SettlementRail.
20. Add programmable settlement interface and local/testnet stub.
21. Add integration/e2e golden-path tests.
22. Deploy staging to Railway/Supabase.
23. Replace fixture connector with first compliant live connectors.
24. Measure time from mission creation to first qualified opportunity.

## 29. Engineering Guardrails

- Do not allow LLM output to directly trigger high-impact tools.
- Do not place private keys in prompts, logs, or general application databases.
- Do not claim “escrow” legally unless the actual provider/legal arrangement supports it.
- Do not scrape sources contrary to their access terms.
- Do not automatically transact in regulated categories.
- Do not silently merge counterparties.
- Do not delete historical opportunity data needed for audit; archive according to retention policy.
- Do not make the blockchain the primary application database.
- Do not couple agents to a specific LLM provider.
- Do not couple transactions to a single payment rail.
- Do not over-fragment into microservices before load/team boundaries justify it.
- Every irreversible or financially material action must be idempotent.
- Every external webhook must be authenticated/verified and replay-safe.
- Every approved action must be revalidated immediately before execution.

## 30. V1 Definition of Done

V1 is successful when a user/operator can:

1. Enter a persistent mission in natural language.
2. Have the system structure the request.
3. Automatically search at least two permitted data sources/adapters.
4. Persist demand and supply observations.
5. Produce and rank matches/opportunities.
6. Show transparent economics and risk.
7. Continuously reverify availability.
8. Generate a negotiation proposal.
9. Receive and decide an approval from Telegram/email.
10. Create a transaction after approved terms.
11. Select a fiat or blockchain-capable settlement plan.
12. Run a sandbox/test progressive-settlement workflow.
13. See a complete transaction/audit timeline.
14. Archive/reactivate the mission without losing history.

The platform must achieve this without giving an AI model unrestricted authority to communicate commitments or move money.

## 31. Key Architectural Decisions to Record as ADRs

- ADR-001: TypeScript monorepo.
- ADR-002: Next.js frontend.
- ADR-003: NestJS/Fastify backend.
- ADR-004: Modular-first architecture with microservice-ready contracts.
- ADR-005: PostgreSQL/Supabase system of record.
- ADR-006: Temporal durable workflows.
- ADR-007: Transactional outbox and versioned domain events.
- ADR-008: Central LLM Gateway.
- ADR-009: Policy-enforced human approval.
- ADR-010: Rail-neutral Settlement Service.
- ADR-011: Blockchain for settlement/proofs, not primary data.
- ADR-012: Hash-chained audit log with optional on-chain anchoring.
- ADR-013: Railway-first, AWS-portable deployment.
- ADR-014: Source access must be permitted/authorized.
- ADR-015: Deterministic final opportunity scoring.

## 32. Context and Token-Efficiency Architecture

Context management is a non-functional engineering requirement.

### 32.1 Session Partitioning

Development should use bounded sessions aligned to modules or phases. Recommended session families:

- architecture / integration;
- frontend / UX;
- mission + demand;
- source connectors;
- matching + scoring;
- agent runtime + LLM gateway;
- risk / anti-gaming;
- approval / notifications;
- transactions;
- fiat payments;
- blockchain settlement;
- fulfillment/logistics;
- observability;
- deployment / infrastructure;
- testing / security review.

A session should not automatically inherit the entire project transcript. It receives a **Context Pack** containing only the relevant specifications, ADRs, interfaces, current task, dependencies, and unresolved decisions.

### 32.2 Context Pack Contract

Each scoped development session should start from:

```text
CONTEXT PACK
- Project identity and one-paragraph goal
- Module scope
- Locked cross-cutting constraints
- Relevant ADRs
- Interfaces/contracts consumed
- Interfaces/contracts produced
- Relevant schema/event definitions
- Current implementation status
- Acceptance criteria
- Explicit out-of-scope items
- Artifact paths / repository locations
```

Context Packs should normally be generated from canonical files, not manually reconstructed from chat history.

### 32.3 Session Handoff Contract

Each module session returns:

```text
SESSION HANDOFF
- What changed
- Decisions made
- Files changed/created
- Public interfaces changed
- Database/event changes
- Tests added / current status
- Known risks
- Remaining work
- Decisions needed from parent/operator
```

Raw command output and exploratory transcripts are excluded unless needed for a specific failure investigation.

### 32.4 Artifact-First State

Canonical project state lives in:

- Git/source files;
- ADRs;
- technical specifications;
- database migrations;
- generated API contracts;
- event schemas;
- test fixtures/results;
- project memory;
- issue/task state.

Chat history is not a canonical source of truth.

### 32.5 Tool Output Budget

For large tool outputs:

1. Save raw output to a file or structured store.
2. Filter/query locally.
3. Return only relevant excerpts/summaries.
4. Include artifact path or stable reference.
5. Preserve raw evidence when audit/debugging value exists.

### 32.6 Subagent Work Contract

When subagents are available, research/mechanical work should be delegated using a bounded contract:

```ts
interface DelegatedTask {
  objective: string;
  inputs: ArtifactRef[];
  constraints: string[];
  allowedTools: string[];
  outputSchema: string;
  maxReturnTokens?: number;
  artifactDestination?: string;
  acceptanceCriteria: string[];
}
```

Subagents return synthesis plus artifact references. The parent session should not ingest their entire scratch history.

### 32.7 Read/Write Efficiency

- Do not reread a complete file after every successful write.
- Verify by test, diff, checksum, targeted line read, or renderer when applicable.
- Batch related edits.
- Prefer patch operations to full rewrites when practical.
- Prefer machine-readable schemas/contracts for repeated context.
- Keep generated logs outside prompt context.

### 32.8 Decision Batching

Product/operator questions should be grouped into decision packets when they are independent enough to answer together.

Example:

```text
DECISION PACKET
1. Connector priority: A / B / C
2. Approval timeout: 15m / 1h / 4h
3. Default stablecoin network: configured option set
4. Mission refresh interval: 5m / 15m / 60m
```

Accepted decisions are immediately persisted to ADR/config/spec artifacts.

### 32.9 Token Telemetry

The LLM Gateway and development tooling should collect:

- input tokens by task/session;
- output tokens;
- cached tokens where provider exposes them;
- estimated USD cost;
- context size;
- model;
- task type;
- artifact reads;
- retry count.

Track:
- cost per qualified opportunity;
- token cost per connector normalization;
- token cost per negotiation draft;
- token cost per completed transaction;
- development-session token spend by module.

### 32.10 Context Compaction

When a session becomes large:

1. Persist current decisions/status.
2. Generate a compact handoff.
3. Start a fresh session.
4. Load only the Context Pack and relevant artifacts.
5. Do not paste the old transcript.

### 32.11 Development Principle

> Conversation is the control plane; source control, files, databases, workflows, and structured artifacts are the memory plane.
