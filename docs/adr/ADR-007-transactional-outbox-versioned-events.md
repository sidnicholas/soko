# ADR-007: Transactional outbox + versioned events

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Persist events in an outbox in the same transaction as state changes; all events are versioned and idempotent.

## Consequences

DB state and events cannot diverge; safe consumers. Requires a relay publisher.
