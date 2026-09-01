# ADR-012: Hash-chained audit log

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Append-only audit events with SHA-256 hash chaining and optional external anchoring.

## Consequences

Tamper-evident history; verifiable in CI. Audit rows are immutable (no UPDATE/DELETE).
