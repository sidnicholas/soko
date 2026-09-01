# ADR-016: V1 decision-packet defaults

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Approval timeout 60m; mission refresh 15m; default stablecoin network base-sepolia; connectors: fixture-supply + fixture-demand first.

## Consequences

Captured from §32.8 decision packet; overridable via env/config. Revisit as live connectors land.
