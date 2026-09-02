# ADR-027: Graph-derived opportunities (arbitrage/bundle as deals)

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-024/026 produced SUBSTITUTE_OF / ARBITRAGE / BUNDLE_AVAILABLE graph edges. Edges are not actionable on their own — operators want *deals*. Arbitrage and bundle opportunities have no demand/supply match, so they did not fit the `opportunities.match_id` model.

## Decision

Opportunities gain a `kind` (`match` default | `arbitrage` | `bundle`), a nullable `match_id`, a `dedupe_key` (unique), and `source_json`. `opportunitiesFromGraph` (lifecycle sweep, after `buildGraphEdges`) turns edges into first-class opportunities:

- **arbitrage** — from cross-entity ARBITRAGE edges: revenue = dearer substitute's min price, cost = cheap entity's min price, profit = spread, role broker (capital-light), scored by `scoreOpportunity`. `dedupe_key = arb:<src>:<dst>`.
- **bundle** — from BUNDLE_AVAILABLE entities: revenue = median price, cost = min price, profit = aggregation savings. `dedupe_key = bundle:<entity>`.

Idempotent on `dedupe_key`; `status = qualified` so they appear on the operator feed alongside match opportunities; first creation emits `opportunity.qualified.v1`.

## Consequences

The graph now feeds the same funnel — a graph opportunity flows through negotiation → approval → escrow like any other. `match_id` is nullable, so `listOpportunitiesByMission` (which joins matches) simply omits graph deals; the operator feed includes them. Bundle economics are a coordination proxy (median−min) until demand quantity/BOM modeling lands; arbitrage assumes a broker fee on the spread rather than inventory purchase.
