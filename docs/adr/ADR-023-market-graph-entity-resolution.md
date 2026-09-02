# ADR-023: Market graph + entity resolution

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-022 added Signals and cross-source synthesis. The next defensibility layer sits between Signals and Supply/Demand: recognizing that observations from different channels are the *same item*, tracking its price over time, and relating listings — the market graph. This powers comparables, price history, "surface similar deals", arbitrage/bundling, and sharper negotiation.

## Decision

Add a canonical-entity + graph layer (`entities`, `entity_members`, `price_observations`, `graph_edges`), resolved deterministically in `@opportunity-os/discovery`:

- **Entity resolution** — `canonicalEntityKey(category, ...texts)` produces a category-prefixed, normalized token signature; supply/demand sharing a key resolve to one `entity` with many `entity_members` across sources. Deterministic and offline (no external service).
- **Price history** — each supply price becomes a de-duplicated `price_observation`; `entityPriceStats` yields min/median/max/count.
- **Market graph** — same-entity supply listings are linked with `PRICE_COMPARABLE` edges (`graph_edges` also holds future `SUBSTITUTE_OF`, cross-market relations).
- **Surfaces** — `GET /entities/:id` returns members + price stats + comparables; `prepareNegotiation` feeds the entity's comparable price range into the drafter so offers are anchored to the market.

`resolveEntities` runs each lifecycle sweep after synthesis.

## Consequences

Comparables, price history, and related-listing graph exist now on stock Postgres. Resolution is a token-signature baseline — brittle to phrasing variants; the planned upgrade is embedding similarity (pgvector) for fuzzy identity, plus `SUBSTITUTE_OF`/arbitrage/bundling edges, which slot in without changing the schema. Every enriched fact remains source-linked (provenance), sharing the evidence discipline of the escrow layer.
