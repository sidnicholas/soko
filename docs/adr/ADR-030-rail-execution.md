# ADR-030: Rail execution on release

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-029 built the escrow condition/release engine, but a release only advanced DB state — no rail was ever called, so money never actually moved. The settlement rails (`StripeFiatRail`, `StablecoinRail`, `ProgrammableSettlementAdapter`) existed and were keyless-testable but unwired.

## Decision

- **Rail selection by family**: the API `SettlementService` composes a rail-neutral `SettlementService` (settlement pkg) via `createSettlementService(config)` — Stripe test (simulated with no key), stablecoin, and the programmable chain — and picks the rail with `byFamily(plan.rail_family)`. Composition lives in the app layer (`apps/api/src/settlement/rails.ts`) because only it may depend on both the settlement abstraction and the on-chain adapter.
- **Prepare at fund**: `fund` calls `rail.prepare(plan)` (create a manual-capture PaymentIntent / chain contract / intent), persists the reference on `settlement_plans.provider_ref` (migration 0010), then advances the plan to FUNDED.
- **Execute at release**: after the release engine approves (and the approval token is verified above threshold), `release` calls `rail.execute({ reference, approvalTokenHash: hashReleaseTerms(...), amount })` — capture/settle — and records the returned `externalRef` on the milestone. Rail failure aborts before any DB release. `SettlementService.execute` refuses an empty approval token hash (§13.5).

## Consequences

Releases now move funds on the selected rail; the escrow flow is authorize (fund) → capture (release), rail-neutral. The programmable adapter is deterministic and in-memory (a single API process holds contract state) — a real on-chain contract needs a security audit before funds (§19.3); the platform never holds fiat funds itself (§19.1). Deferred: multi-recipient splits (the `recipients` field is threaded but not populated), refund/dispute execution, and a durable outbox-driven `status` reconciliation for async (non-simulated) rail confirmations. Prepare-then-execute spans the rail and DB without a distributed commit; for the local reference rails this is deterministic and re-runnable, but a production fiat/chain rail needs idempotent execute + reconciliation.
