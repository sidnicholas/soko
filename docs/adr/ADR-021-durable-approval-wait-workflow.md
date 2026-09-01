# ADR-021: Durable approval-wait execution workflow

- Status: Accepted
- Date: 2026-09-01
- Supersedes the "Temporal approval wait deferred" note in ADR-019.

## Context

§11.2(5-10) require a durable workflow that requests a human gate, waits for the approval decision, and executes the binding action only on approval. ADR-019 shipped the synchronous HTTP path and deferred the Temporal wait for lack of a cluster.

## Decision

`opportunityExecutionWorkflow` now: runs `requestApprovalActivity` (creates the approval, emits `approval.requested.v1`), waits on `approvalSignal` bounded by the approval timeout (`condition(..., "N minutes")`), and on approve runs `executeProposalActivity`, which verifies the approval token cryptographically (same `hashProposalTerms` + `verifyApprovalToken` as the HTTP path), confirms the approval row is approved, and creates the audit-backed proposed transaction. Reject or timeout returns without executing. The proposal-terms hash lives once in `@opportunity-os/audit` so a token minted on either path verifies on the other. `apps/worker-temporal/src/client.ts` exposes `startOpportunityExecution` + `signalApprovalDecision` as the deployment integration point (API starts the workflow on operator action; approve/reject signals it after writing the approval row and minting the token).

## Consequences

The durable and synchronous paths share the same activities, token crypto, and audit chain — no logic divergence. Verified against the Temporal time-skipping test server with real activities + Postgres (approve/reject/timeout) via `scripts/verify-execution-workflow.ts`; the workflow-runtime check runs there rather than in the vitest suite (it needs the Temporal test server binary, not a plain unit environment). API↔Temporal wiring stays behind the client helper so the cluster-less V1 API is unaffected until a Temporal deployment exists.
