# ADR-006: Temporal durable workflows

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Orchestrate discovery/execution/settlement with Temporal.

## Consequences

Durable, retryable, signal-driven human gates. Adds a workflow runtime dependency.
