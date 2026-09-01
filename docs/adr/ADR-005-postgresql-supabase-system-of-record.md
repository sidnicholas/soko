# ADR-005: PostgreSQL/Supabase system of record

- Status: Accepted
- Date: 2026-08-31

## Context

Derived from the V1 Technical Specification (see docs/Opportunity_OS_V1_Technical_Specification.md §31).

## Decision

Use PostgreSQL (initially Supabase) as the primary datastore with RLS on user-facing tables.

## Consequences

Relational integrity, RLS, managed auth/storage. Blockchain is never the primary DB (ADR-011).
