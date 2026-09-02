# ADR-025: Embedding provider via the LLM gateway

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-024 used a local hashed embedding (lexical only). For real semantic similarity (substitutes/comparables) we need a proper model, chosen for capital-light economics (short listing text, cost-sensitive, low early volume) rather than leaderboard deltas.

## Decision

Embeddings route through the LLM gateway (`EmbeddingGateway`), provider-agnostic and swappable:

- **Default: OpenAI `text-embedding-3-small` @ dim 512** (Matryoshka `dimensions`) — cheap, strong, small vector → small pgvector footprint.
- **Alt: Voyage `voyage-3-lite`** (512 dim) — swappable via `EMBEDDING_PROVIDER=voyage`.
- **Fallback: `EchoEmbeddingModel`** — deterministic hashed embedding at the configured dim; used for dev/CI/offline and whenever the primary provider errors or lacks a key. Keeps everything keyless-testable.

Config: `EMBEDDING_PROVIDER` (echo|openai|voyage, default echo), `EMBEDDING_MODEL`, `EMBEDDING_DIM` (default 512), `VOYAGE_API_KEY`. `resolveEntities` batch-embeds entities in one gateway call; vectors stored as jsonb (ADR-024); cosine in app.

## Consequences

Ship keyless now (echo); flip to OpenAI/Voyage by env in prod with a re-embed backfill. Dim is locked per active model — switching models = new dim = re-embed (store dim per row if mixing). Self-hosted small models (bge/nomic) and **pgvector** on Supabase (vector column + hnsw + cosine in SQL) are the scale upgrades and slot in behind the same `EmbeddingModel`/storage seams. Real embeddings are non-deterministic across versions, so tests assert threshold behavior via echo, not exact vectors.
