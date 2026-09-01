# ADR-011: Blockchain for settlement/proofs only

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Use chains for settlement and tamper-evidence, never as the primary application database.

## Consequences

Private data stays off-chain (§19.4); only hashes/attestations anchored.
