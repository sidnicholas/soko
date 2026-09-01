# ADR-004: Modular-first, microservice-ready

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Deploy a modular monolith plus separate worker processes; communicate via typed commands/events.

## Consequences

Low ops cost now; clean extraction later. Requires event/command discipline (outbox).
