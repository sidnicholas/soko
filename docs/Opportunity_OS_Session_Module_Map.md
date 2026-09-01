# Opportunity OS — Recommended Session / Module Map

Use this file to decide **where a new task belongs** before opening or continuing a coding-agent session.

| Session | Owns | Reads | Produces |
|---|---|---|---|
| ORCHESTRATOR | Architecture, integration, cross-cutting decisions | all handoffs/ADRs | ADRs, integration decisions, next-task packets |
| FRONTEND | Next.js UI/UX, missions, opportunities, transactions | API contracts, design rules | pages/components/client contracts |
| DEMAND | Mission, MissionVersion, Demand Specification | product spec | schemas, parsers, APIs/events |
| CONNECTORS | source SDK, ingestion, normalization entry | connector policy | adapters, observations, source evidence |
| MATCHING | matching/economics/scoring | demand/supply schemas | matches, scores, explanations |
| AGENTS | runtime, LLM gateway, Temporal agent tasks | domain contracts | task interfaces, routing, prompts |
| RISK | fraud, anti-gaming, prompt injection, policy gates | events/evidence | risk scores, policy decisions |
| APPROVAL | human gate, Telegram/email | proposed action contracts | approvals/signals/notifications |
| TRANSACTION | transaction state machine, terms | approved opportunity | transactions, state events |
| FIAT | card/ACH/provider adapters | settlement interface | fiat rail implementation |
| CHAIN | blockchain/progressive settlement/proofs | settlement interface | smart contracts/adapters/proof schemas |
| FULFILLMENT | shipping/service logistics | transaction terms | quotes, milestones, fulfillment events |
| DATA | Postgres/Redis/search/Opportunity Graph | domain models | migrations/indexes/repositories |
| INFRA | Railway/AWS/CI/CD/secrets/monitoring | deploy manifests | infrastructure |
| QA | E2E/security/adversarial tests | all public contracts | test reports, release gates |

## Session Creation Rule

Open a new session when the task:
- belongs to a different row than the current session;
- starts a new implementation phase;
- requires large research/tool output;
- would force unrelated context into the current thread.

## Cross-Session Rule

Never communicate module state by pasting a prior transcript. Use:
- ADRs;
- contracts;
- migrations;
- `CONTEXT_PACK.md`;
- `SESSION_HANDOFF.md`;
- code/tests.
