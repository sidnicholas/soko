# ADR-015: Deterministic final scoring

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Final opportunity ranking is deterministic, versioned code; LLMs may only estimate components.

## Consequences

Reproducible, auditable ranking. Formula changes are versioned (score_version).
