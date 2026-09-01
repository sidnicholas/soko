# ADR-008: Central LLM Gateway

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Route all model calls through a provider-agnostic gateway with budgets, fallback, redaction, and cost telemetry.

## Consequences

No vendor lock-in; cost control; injection fencing. Slight indirection per call.
