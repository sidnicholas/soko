# ADR-024: Entity embeddings + substitute/arbitrage/bundle edges

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-023 built canonical entities + price history + PRICE_COMPARABLE edges via exact token-signature keys — brittle to phrasing variants and unable to relate *different but interchangeable* items. The graph payoff needs fuzzy similarity (substitutes), cross-price detection (arbitrage), and aggregation (bundling).

## Decision

- **Embeddings** — `EmbeddingProvider.embed(text)` with a deterministic offline `LocalHashEmbedding` (hashed bag-of-words, L2-normalized) as the V1 default; `cosineSimilarity` for comparison. Stored on `entities.embedding` as a jsonb float array so it runs on plain Postgres/CI. `resolveEntities` embeds each entity.
- **SUBSTITUTE_OF** — within a category, entity pairs with cosine ≥ 0.6 (different canonical key) get bidirectional SUBSTITUTE_OF edges (weight = similarity).
- **ARBITRAGE** — an entity whose observed price spread `(max-min)/max ≥ 0.2` across ≥2 observations gets an ARBITRAGE marker edge (weight = spread): buy low, sell high, same item.
- **BUNDLE_AVAILABLE** — an entity with ≥2 available sellers gets a marker edge (weight = seller count): several sellers can jointly satisfy one buyer.

`buildGraphEdges` runs each lifecycle sweep after `resolveEntities`; edges surface via `GET /entities/:id`.

## Consequences

Fuzzy substitutes, arbitrage flags, and bundle readiness now exist with no external model and no pgvector. Two upgrades slot in without touching callers: (1) a real embedding provider (OpenAI/Voyage via the LLM gateway) for semantic quality; (2) **pgvector** on Supabase prod — swap `entities.embedding` jsonb → `vector` column + ANN index and push the cosine into SQL for scale. Unbundling (warehouse → parts) needs component/BOM decomposition data not yet modeled and is deferred.
