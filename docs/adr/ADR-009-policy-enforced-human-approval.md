# ADR-009: Policy-enforced human approval

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

High-impact actions require a policy-gated approval with a signed one-time token and payload-hash match.

## Consequences

No AI self-authorization of money/commitments. Approval invalidated when material terms change.
