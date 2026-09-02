# ADR-031: Refund/dispute execution

- Status: Accepted
- Date: 2026-09-02

## Context

ADR-029's `decideRelease` already returned `"hold"` (disputed) and `"auto_refund"` (deadman timeout) outcomes, but `SettlementService.release` in `apps/api` just threw `ConflictException` on either — `disputed` was hardcoded `false`, no caller could ever mark a milestone/plan DISPUTED or FROZEN, and no rail refund was ever executed. `SettlementRail.refund` existed on the interface (optional) and was implemented on all three rails (`StripeFiatRail` real, `StablecoinRail` stub-fails, `ProgrammableSettlementAdapter` real), but nothing called it. `SettlementStatus`/`SETTLEMENT_TRANSITIONS` already modeled DISPUTED/FROZEN as reachable states but had no terminal REFUNDED status, and the milestone `status` check constraint had no `'refunded'` value.

Persisting deadman/optimistic-window timestamps and driving them from a durable (Temporal) wait is a separate, larger piece of work (ST-13/WF-3) — out of scope here. This ADR only wires the parts that are reachable today: an operator (or `service` actor) manually disputing/freezing a plan, and refunding it (either automatically, if `decideRelease` ever does return `auto_refund` once ST-13 lands, or manually to resolve a dispute).

## Decision

- **REFUNDED status**: added to `SettlementStatus` (contracts) and `SETTLEMENT_TRANSITIONS` (domain) as a terminal state reachable from `FUNDED`/`MILESTONE_PENDING`/`MILESTONE_VERIFIED`/`AWAITING_RELEASE_APPROVAL`/`PARTIALLY_SETTLED`/`DISPUTED`/`FROZEN` — anywhere funds could still be held. Migration `0011` widens the milestone `status` check constraint to include `'refunded'` and adds `disputed_at`/`frozen_at`/`refunded_at` (plan) and `disputed_at`/`refunded_at`/`external_refund_ref` (milestone) columns.
- **`SettlementRail.dispute?`/`freeze?`**: added as optional rail methods (mirroring `refund?`) so a rail that models on-chain state (the programmable adapter) gets a best-effort signal; DISPUTED/FROZEN is authoritative in the domain state machine regardless of whether the rail implements them.
- **New repo functions** (`packages/db/src/repositories/settlement.ts`): `disputeMilestone`, `freezeSettlementPlan`, `refundMilestone` — each a guarded `stepPlan` transition + audit event + outbox event (`settlement.disputed.v1`, `settlement.frozen.v1`, `settlement.refunded.v1`), following the same transactional shape as `releaseMilestone`. Disputing/refunding also pushes the transaction toward `disputed`/`cancelled` when legal.
- **New API surface**: `POST /settlement/milestones/:id/dispute`, `POST /settlement/plans/:id/freeze` (both gated by a new `settlement:dispute` permission, no approval token — they block money, they don't move it), and `POST /settlement/milestones/:id/refund` (gated by `settlement:release` **and** an approval token bound via a new `hashRefundTerms` — a distinct action string from `hashReleaseTerms` so a release token can never authorize a refund). `release()` now reads the plan's real `DISPUTED`/`FROZEN` status into `decideRelease`'s `disputed` field instead of a hardcoded `false`, and its `auto_refund` branch executes a real refund (shared `executeRefund` helper) instead of throwing.
- **Refund execution**: `executeRefund` calls `rail.refund(reference, amount)` when the rail supports it (Stripe/chain do; stablecoin's stub still fails closed per its `supportsRefund: false` capability flag), then persists via `refundMilestone`. Rail failure aborts before any DB refund, mirroring ADR-030's release-execution ordering.

## Consequences

DISPUTED and FROZEN are now real, audited, event-emitting operations, not just reachable-in-theory state-machine nodes. A disputed milestone genuinely blocks release (`decideRelease` sees the real flag) and can be resolved via a token-gated manual refund. What's still deferred: automatic deadman-triggered refund (needs ST-13's persisted `deadman_at` + a durable trigger — the `auto_refund` execution path is wired and will fire the moment that lands), dispute *resolution* back to a releasable state (currently one-way: dispute → refund; un-disputing to retry release isn't modeled), and multi-party refund splits (mirrors ADR-030's deferred `recipients` population).
