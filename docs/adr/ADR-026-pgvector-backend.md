# ADR-026: pgvector backend on Supabase

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-024 stored embeddings as jsonb with app-side O(n²) cosine — fine for CI/offline, not for scale. pgvector (Supabase prod) gives an ANN index + cosine in SQL. But plain Postgres/CI lacks the `vector` extension, so it cannot be a mandatory migration.

## Decision

pgvector is an **opt-in backend** selected by `EMBEDDING_BACKEND` (jsonb default | pgvector):

- **Core migrations stay jsonb-only** (`entities.embedding jsonb`) — run everywhere unchanged.
- **Separate bootstrap** `pnpm db:pgvector` (`packages/db/src/pgvector.ts`): `create extension vector`, add `embedding_vec vector(512)`, `hnsw (embedding_vec vector_cosine_ops)` index, backfill from jsonb. Guarded — if the extension is absent it logs and skips, so it is safe to invoke anywhere. Run on Supabase / the pgvector CI job.
- On the pgvector backend, `setEntityEmbedding` dual-writes jsonb + `embedding_vec`; `buildGraphEdges` builds SUBSTITUTE_OF via `nearestEntitiesByVector` (`<=>` cosine, index-accelerated) instead of app-side pairwise.
- **CI job `pgvector`** runs on `pgvector/pgvector:pg16`: migrate → `db:pgvector` → the pgvector NN test. It is the verification surface (local dev + plain CI lack the extension, so the pgvector test skips there).

## Consequences

Default path (jsonb + app cosine) is unchanged and green on plain Postgres/CI. The pgvector path is exercised only where the extension exists; correctness rests on the dedicated CI job, not local runs. Dim is locked at 512 (matches `EMBEDDING_DIM` / OpenAI-small Matryoshka) — changing it requires a new column + re-backfill. Next: push top-K substitute selection fully into SQL and add cross-entity ARBITRAGE via vector+price joins.
