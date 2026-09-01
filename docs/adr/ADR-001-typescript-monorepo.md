# ADR-001: TypeScript monorepo

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Use a pnpm + Turborepo TypeScript monorepo with strong domain boundaries.

## Consequences

Single language across web/api/workers; shared contracts; simpler refactors. Requires workspace tooling discipline.
