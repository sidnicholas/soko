# ADR-029: Escrow condition/release engine (Transaction-OS backbone)

- Status: Accepted
- Date: 2026-09-01

## Context

Settlement had a rail-neutral abstraction (`settlement`/`chain`) and a progressive state machine (`domain`), but `settlement_milestones.release_conditions_json` / `required_evidence_json` were inert columns. To become a transaction operating system, the platform needs a deterministic engine that decides when a milestone's money may move, backed by tamper-evident evidence — the "meeting of the minds" the escrow enforces.

## Decision

- **Condition DSL** (`contracts/escrow.ts`): a versioned AND/OR tree of typed predicates — `shipment_delivered`, `document_signed`, `gps_within_geofence`, `sensor_threshold`, `time_elapsed`, `milestone_attested`, `oracle_true`. Each leaf carries a minimum evidence trust tier.
- **Evaluator** (`packages/escrow` `evaluateCondition`): pure, deterministic, versioned (`CONDITION_VERSION`). The only authority that flips `MILESTONE_PENDING -> MILESTONE_VERIFIED`. Evidence is data, verified before it can move state.
- **Release policy** (`packages/escrow` `decideRelease`, `RELEASE_VERSION`): dispute freezes; deadman timeout auto-refunds; otherwise release when conditions are met (or an optimistic window elapsed), auto-releasing below the human-control threshold and requiring a human approval token above it (reuses the ADR-019 approval-token model via `hashReleaseTerms`).
- **Verifier adapters** (`packages/verifiers-sdk`): `EvidenceVerifier` mirrors connectors-sdk — pluggable, source-tagged, deterministic. Local reference impls (`makeAttestationVerifier`, `makeSignedDocumentVerifier`) run keyless; production carrier/e-sign/oracle verifiers implement the same shape and set higher trust tiers.
- **Evidence ledger** (migration 0009): the `evidence` table becomes append-only and hash-chained per `(entity_type, entity_id)` — each row carries `verifier`, `trust_tier`, `predicate_type`, `previous_evidence_hash`, `evidence_hash`. `verifyEvidenceChain` detects tampering.
- **Repos + API** (`db/repositories/settlement.ts`, `apps/api/src/settlement`): fund a plan, submit evidence (verify -> ledger -> evaluate -> verify milestone), release (engine decides auto vs token-gated), and settle the transaction once all milestones release — every hop guarded by the domain state machine and recorded on the audit chain.

## Consequences

Milestones now release on real, auditable conditions, not manual flips. `settlement:release` is a plain-gated permission whose money control is the release engine + cryptographic token (auto below threshold, human above), so small releases automate while large ones stay human-gated. Deferred: on-chain/Stripe rail execution (funds still never held by the platform — a licensed partner will), refund/dispute *execution* (the decision is modeled; the payout path is not), and Temporal-durable release waits (the same token drives them when Temporal lands, per ADR-017/019). Optimistic/deadman windows are per-milestone inputs, not yet persisted columns.
