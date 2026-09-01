# ADR-010: Rail-neutral Settlement Service

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Expose a unified SettlementRail abstraction across fiat, stablecoin, and programmable on-chain rails.

## Consequences

Transactions never coupled to one rail; progressive enablement. Adapter surface to maintain.
