# ADR-003: NestJS + Fastify backend

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Implement the API/BFF with NestJS on the Fastify adapter.

## Consequences

DI, modular structure, OpenAPI generation; Fastify performance. Decorator/metadata build config required.
