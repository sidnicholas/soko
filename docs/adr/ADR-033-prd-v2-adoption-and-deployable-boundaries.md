# ADR-033: Adopting PRD v2 — phased, with the API as the only binding authority

- Status: Accepted
- Date: 2026-10-15

## Context

`docs/Opportunity_OS_Integrated_PRD_v2.md` proposes a broad brokerage
operating system: independent supply and demand intelligence, relationship
memory, outreach, deal strategy, counterparty deal rooms, contracts, trust
checks, licensed escrow, logistics, insurance and learning. It lists up to 13
deployables, about 50 new tables and 10 new packages, and phases them P0–P5
with acceptance gates. It was written from the application audit, not from
the code (its §1 says so).

## Decision

- **Phase gates are binding.** P0 (stabilize) is completed and verified in
  production before P1 work starts; each later phase starts only when the
  previous phase's "Pass" criteria hold. Work inside a phase is one vertical
  slice at a time: contracts → migration/RLS → package → API → worker → UI →
  tests → ADR/docs.
- **Modular monolith stays.** New capabilities are packages composed by the
  existing hosts. A new deployable is added only for independent scale,
  credentials, fault domain or latency (PRD §3.1), and only when that pressure
  is real; the PRD's list of workers is a target, not a starting point.
- **The API is the only binding authority** (PRD §3.2). Workers may read,
  ingest, score and propose; any outreach, commitment, disclosure or money
  movement is a command to the API, which checks permissions, approval tokens
  or (later) delegation grants, and writes state, audit and outbox together.
  Existing workers that write discovery data directly (connectors, lifecycle,
  intel) are within this rule: they write no binding state.
- **No duplicate truth tables** (PRD §7). New tables extend the canonical ones
  (`counterparties`, `opportunities`, `transactions`, `settlement_plans`,
  `evidence`, `outcomes`) by foreign key.
- **Canonical deal id.** Before P2/P3 work, one id must follow a deal from
  discovery to closure (PRD §3.5). Today an intel candidate, an off-network
  deal, an opportunity and a transaction are separate records. The deal id
  will be introduced with the first P2/P3 slice that needs it, as a column on
  the existing records, not a parallel deals table that copies them.
- **Status vocabulary for providers** (PRD §3.7): `proposed`, `configured`,
  `sandbox_verified`, `production_verified`. Nothing simulated is shown as
  real.

## Consequences

- P0 items that need production access (verifying 0022 and 0024 against the
  live database, enabling the outbox relay on Railway, real webhook
  signatures) are tracked as operator steps; code changes alone do not close
  them.
- The settlement timer workflow's auto-refund and below-threshold
  auto-release (ADR-029) are deterministic policy outcomes, not agent
  decisions, and stay. PRD §9 forbids autonomous *live* release; there are no
  live rails yet, and enabling one requires revisiting this.
- Product decisions in PRD §17 (jurisdictions, channels, exposure caps,
  providers, retention) gate P1–P4 slices that depend on them.

## Exceptions recorded

- 2026-10-17: the product owner started P2 slice 1 (contacts and consent)
  before the P1 gate review. P1 slices 1–3 are live and measured; the gate
  review (verified leads per dollar against the Brave baseline) still runs
  on the next day's data and its result is recorded in the PRD plan. Outreach
  (P2 slice 2) does not start until that review passes.
