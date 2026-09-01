# ADR-019: Approval tokens and synchronous gated execution

- Status: Accepted
- Date: 2026-09-01

## Context

§14/§22 require binding commitments (transaction proposal, sending negotiations, moving money) to be human-gated, and an executor must present "an approved command with matching payload hash". `authorize()` already reserved a `hasApprovedActionToken` gate but nothing minted or verified a real token. Temporal (the durable approval-wait engine, §11.2) is not provisioned in V1 (see ADR-017).

## Decision

Approval is a signed capability. `@opportunity-os/auth` mints an HMAC-SHA256 token (secret: `APPROVAL_TOKEN_SECRET`) only when a human approves/modifies an approval; claims bind `{approvalId, action, entityType, entityId, payloadHash, expiresAt}`. The payload hash is computed identically at request time and execution time (`hashActionPayload` = sha256 of canonical JSON), so a token authorizes exactly the command a human saw and nothing else.

Execution is synchronous over HTTP in V1: agent/operator `POST /opportunities/:id/request-approval` (proposer, `approval:create`) → operator decides `POST /approvals/:id/approve` (approver, `approval:decide`) which returns the token → operator `POST /transactions/propose` with `X-Approval-Token`, which re-verifies signature/expiry/action/payload-hash, confirms the approval row is still approved, then creates the proposed transaction and records a hash-chained audit event. Proposer ≠ approver (separation of duties). Notifications are delivered by the notifications worker polling pending/undelivered approvals (DB-driven, no message bus).

## Consequences

Real cryptographic gating with no Temporal dependency; the whole loop is DB-testable. When Temporal lands, `opportunityExecutionWorkflow` mints/consumes the same token type, so the crypto and audit paths are unchanged — only the wait substrate differs. Audit appends serialize on a Postgres advisory lock to keep the chain head race-free. `X-Approval-Token` presence is the coarse RBAC gate; the per-action cryptographic check in the service is authoritative.
