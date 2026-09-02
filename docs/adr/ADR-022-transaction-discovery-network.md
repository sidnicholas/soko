# ADR-022: Signals → Outcomes transaction-discovery network

- Status: Accepted
- Date: 2026-09-01

## Context

The product is more than a marketplace aggregator: opportunities should arise from *any* channel and even from connecting two independent facts (buyer wants X, supplier has X) with no listing. And every completed deal should teach the system. The domain model already ran `Supply → Demand → Match → Opportunity → Negotiation → Transaction`; it needed a source-agnostic front (Signal) and a learning tail (Outcome).

## Decision

Add two first-class objects and one engine change:

- **Signal** (`signals` table, `/signals` intake) — a raw, source-tagged claim (`supply`/`demand`) from any channel (public web, official API, browser extension, user-submitted, merchant feed, request mining). Captured with provenance (`content_hash`, `source_reliability`), then **projected** into a Supply or Demand row so it enters the existing matching machinery. Kept even if never resolved (graph/learning fuel).
- **Cross-source synthesis** (`synthesizeOpportunities`) — matches every open demand against all available supply regardless of source, so opportunities are synthesized from independent signals. The score/persist logic is factored into one shared `scoreAndPersistOpportunity` used by both mission discovery and synthesis. Runs each lifecycle sweep; idempotent via the `(demand_id, supply_id)` match key.
- **Outcome** (`outcomes` table, `recordOutcome`/`outcomeStats`) — the realized result (won/lost, sale price, days-to-close, profit) of a pursued opportunity. Seeds score calibration; the dataset that outvalues raw scrape.

Internal spine: `Signals → (Entities) → Supply → Demand → Matches → Opportunities → Negotiations → Transactions → Outcomes`.

## Consequences

Every future channel is just another Signal source (thin adapter). Opportunities no longer require listings. Entity resolution + market graph (canonical dedupe, comparables, price history, arbitrage/bundling) are the next layer and slot in between Signals and Supply/Demand. `Outcome` closes the learning loop that later recalibrates `scoring`. Ingestion legality (ToS/robots/CFAA), request-mining PII, and resale-ToS remain policy gates in `risk`, not afterthoughts.
