# Opportunity OS — Context, Token & Session Efficiency Technical Specification

**Version:** 1.0  
**Status:** Required development operating specification  
**Date:** August 31, 2026

## 1. Purpose

This specification defines how Opportunity OS development and AI operations preserve tokens, reduce context bloat, minimize repeated reasoning, and maintain reliable cross-session continuity.

The system assumes that long-lived chat transcripts are an inefficient place to store canonical project state.

> **Conversation is the control plane. Structured artifacts are the memory plane.**

## 2. Objectives

The architecture must:

- keep individual AI sessions bounded;
- minimize repeated project context;
- prevent raw tool noise from entering parent contexts;
- preserve decisions reliably across sessions;
- make module handoffs deterministic;
- reduce inference cost;
- support multiple coding/research agents without losing architectural coherence;
- make it cheap to restart work in a fresh session;
- retain enough evidence for debugging and audit.

## 3. Canonical Memory Hierarchy

Use this precedence order:

1. Source code and tests.
2. Database migrations / generated schemas.
3. Architecture Decision Records (ADRs).
4. Current technical specifications.
5. API/event/interface contracts.
6. Project memory Markdown.
7. Task/session handoff files.
8. Conversation history.

If chat conflicts with a newer canonical artifact, the artifact wins unless the operator explicitly overrides it.

## 4. Session Topology

Recommended dedicated sessions:

| Session | Primary Scope |
|---|---|
| ORCHESTRATOR | Cross-module architecture, decisions, integration |
| FRONTEND | Next.js UX, missions, transactions, collaboration |
| DEMAND | Mission/Demand model and intent parsing |
| CONNECTORS | Source adapters, ingestion, source policy |
| MATCHING | Matching, economics, opportunity scoring |
| AGENTS | Agent runtime, orchestration, LLM Gateway |
| RISK | Trust, anti-gaming, fraud, compliance gates |
| APPROVAL | Telegram/email approval and policy gates |
| TRANSACTION | Agreements, transaction state machine |
| FIAT | Stripe/card/ACH adapters |
| CHAIN | Blockchain settlement and proof architecture |
| FULFILLMENT | Logistics/service fulfillment |
| DATA | Postgres, Redis, search, Opportunity Graph |
| INFRA | Railway/AWS, secrets, CI/CD, observability |
| QA | Integration, E2E, adversarial/security testing |

Create additional sessions only when scope justifies them.

## 5. Context Pack

Every fresh module session receives a generated `CONTEXT_PACK.md`.

Template:

```markdown
# Context Pack
## Project
One-paragraph project definition.

## Session Scope
What this session owns.

## Locked Constraints
Only constraints relevant to this scope.

## Consumed Interfaces
Schemas/APIs/events this module depends on.

## Produced Interfaces
Schemas/APIs/events this module owns.

## Relevant ADRs
Links/paths.

## Current State
Implemented / incomplete / broken.

## Acceptance Criteria
Testable exit criteria.

## Out of Scope
Explicit exclusions.

## Required Artifacts
Paths to read, not pasted contents unless small.

## Open Decisions
Only decisions blocking this session.
```

Target: context packs should normally be small enough to inspect quickly and should not duplicate entire master specifications.

## 6. Session Handoff

Every scoped session ends with a machine-readable and human-readable handoff.

Recommended file: `SESSION_HANDOFF.md` or JSON alongside it.

Required fields:

- summary;
- commits/files changed;
- API/interface changes;
- database migrations;
- events added/changed;
- tests and status;
- deployment impact;
- security implications;
- unresolved issues;
- decisions needed;
- artifacts produced.

The parent/orchestrator ingests the handoff, not the session's full transcript.

## 7. Subagent Delegation

Delegate work that is:

- research-heavy;
- exploratory;
- high-volume;
- mechanical;
- file-search intensive;
- repetitive;
- easily bounded by acceptance criteria.

Examples:
- search 5,000 source records;
- inspect a large API schema;
- generate fixtures;
- refactor a package;
- run compatibility research;
- compare infrastructure options.

Subagent contract:

```ts
type DelegatedTask = {
  id: string;
  objective: string;
  inputs: ArtifactRef[];
  constraints: string[];
  expectedArtifacts: ArtifactSpec[];
  returnSchema: JSONSchema;
  maxSummaryTokens: number;
  acceptanceCriteria: string[];
};
```

Return policy:

- summary;
- important evidence;
- decisions/recommendations;
- artifact references;
- failures/blockers.

Do not return raw scratch reasoning or full tool transcripts.

## 8. Raw Tool Output Policy

Never paste large raw output into main context unless required to debug a specific issue.

For JSON/API/log output:

```text
command/API
    ↓
raw file
    ↓
jq / SQL / Python / parser
    ↓
small structured result
    ↓
main session
```

Recommended storage:

```text
.artifacts/raw/
.artifacts/derived/
.artifacts/reports/
```

Large data should be addressed by path, hash, ID, or query rather than pasted.

## 9. File Read Policy

After writing a file:

- trust successful tool confirmation for basic existence;
- verify semantically using tests/diffs/targeted reads;
- use full rereads only when necessary;
- use render-and-inspect for layout-sensitive documents;
- query large files by exact range/selector;
- store checksums for important generated artifacts.

## 10. Decision Batching

The operator should receive grouped decisions rather than repeated serial interruptions.

Use:

```markdown
# Decision Packet
| ID | Question | Recommended | Options | Consequence |
|---|---|---|---|---|
```

Record approved decisions into ADRs/spec/config immediately.

## 11. Long-Running Work

Where background jobs are supported:

- start a job once;
- persist job ID;
- emit completion event/webhook;
- fetch final result once.

Avoid rapid conversational polling.

Where background jobs are unavailable:

- use coarse status checks;
- suppress repeated verbose logs;
- return only meaningful progress/change.

## 12. Context Budget Classes

Suggested classes:

- **Tiny:** <8K tokens — isolated mechanical work.
- **Standard:** <24K — most module implementation sessions.
- **Extended:** <48K — complex integration/review.
- **Reset Required:** when context materially exceeds the module's useful working set.

Do not use the model's maximum context as the target.

## 13. Compaction Trigger

Start a new session when any occurs:

- repeated references to old turns become common;
- more than two unrelated modules are active;
- prompts regularly restate previous decisions;
- session summaries become longer than current task;
- debugging logs dominate context;
- implementation phase changes;
- large refactor changes the assumptions of the session.

Compaction procedure:

1. Update canonical files.
2. Write handoff.
3. Record open decisions.
4. Start fresh session.
5. Load Context Pack.
6. Continue from artifacts.

## 14. LLM Runtime Token Controls

The production LLM Gateway should support:

- task-specific max input/output;
- model selection by complexity;
- caching;
- structured output;
- retrieval limited to relevant records;
- prompt templates by version;
- summary memory;
- batch classification/extraction;
- deduplication before inference;
- cheap model first for routine tasks;
- escalation only on low confidence or high economic value.

## 15. Retrieval Before Reasoning

Agents should retrieve narrow structured context instead of loading entire histories.

Examples:
- current MissionVersion, not every prior version;
- top 10 viable matches, not all supply;
- transaction state + last 5 relevant events, not complete audit log;
- summarized counterparty profile + cited evidence, not all raw source pages.

Historical data remains accessible on demand.

## 16. Token Cost Telemetry

Persist:

```text
session_id
task_id
agent_type
model
provider
input_tokens
output_tokens
cached_tokens
estimated_cost_usd
latency_ms
retry_count
artifact_bytes_read
records_retrieved
```

Operational KPIs:

- tokens per qualified opportunity;
- cost per qualified opportunity;
- tokens per successful match;
- tokens per transaction completed;
- tokens per $1 gross profit;
- model cost as % of expected net profit;
- development tokens per module;
- escalation rate from cheap to premium models.

## 17. Economic Guardrail

AI spend belongs in transaction economics.

For an opportunity:

```text
Expected Net Profit =
Revenue
- acquisition/fulfillment
- payment/settlement fees
- logistics
- expected risk loss
- human labor
- AI/model/tool cost
```

The engine should reject or downgrade opportunities where inference/tool cost destroys expected profit.

## 18. Oh My Pi Operating Instructions

For each module:

1. Read `CONTEXT_PACK.md`.
2. Read only referenced specs/ADRs needed for the task.
3. Do not ingest master project history unless explicitly required.
4. Work in scoped commits.
5. Put large outputs into `.artifacts`.
6. Use targeted queries on `.artifacts`.
7. Update contracts/tests when interfaces change.
8. Create/update ADR for architectural decisions.
9. End with `SESSION_HANDOFF.md`.
10. Keep handoff concise.

## 19. Definition of Done

This specification is operational when:

- project work can move to a fresh session without replaying chat history;
- each module has an addressable context pack;
- session handoffs are standardized;
- raw tool output is externalized;
- model usage is measured;
- AI cost is included in opportunity economics;
- coding/research subagents return synthesis instead of noise;
- architecture decisions persist in canonical artifacts;
- the orchestrator can reconstruct current state from files/source control.
