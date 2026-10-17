# ADR-044: Good-deal filter for actor listings

- Status: Accepted
- Date: 2026-10-17
- Product owner request ("surface only good deals"); builds on ADR-039, ADR-042

## Context

Actor sources (first: Facebook Marketplace, ADR-043) bring hundreds of
listings a day into the supply pool. The owner wants to see only good deals.
A paid assessment per listing would cost more than the listings are worth;
most listings are priced at or above market.

## Decision

- **Screen, then assess.** `worker-connectors` checks new actor listings
  each sweep (`DEAL_CHECKS_PER_RUN`, default 100; newest first, last 7
  days; merged duplicates skipped). For each: a comparables search from the
  title's meaningful words, run against the eBay Browse API (official, free,
  already configured); the median price of comparables in the same currency,
  a tenth trimmed off each end when enough remain; at least 5 comparables or
  no verdict (`no_comps`, never a guess).
- **Verdicts** (`deal_checks`, one per observation, with the comparables
  kept as evidence): `good_deal` at least `DEAL_MIN_DISCOUNT` (default 30%)
  under the median, halved when the listing matches a recent observed buyer
  request; `fair`, `overpriced`, `no_comps`, `no_price`.
- **Only good deals become leads** (`DEAL_LEADS_PER_RUN`, default 10;
  buyer-request matches first): a supply lead with the listed price, the
  comparables' median and the discount as facts, buyer-search queries for
  the counterpart stage, and a credibility that ranks deeper discounts and
  buyer matches first in the assessment pool. From there the supply lane
  runs as for any lead — buyer search, delivered-cost economics, scoring —
  and only what nets a profit reaches the Action Queue.
- The actor's panel on Source Registry shows the week's verdict counts and
  leads raised.

## Consequences

- Comparables are active asking prices, so discounts overstate a bargain
  against what items sell for; the bar is set accordingly and the
  assessment decides. Lots and bundles rarely find comparables and stay out.
- Deal leads compete for the supply lane's counterpart searches and
  assessments (`INTEL_COUNTERPART_SEARCHES`, `INTEL_MAX_ASSESSMENTS`); raise
  them if good deals queue up.
- eBay Browse calls count against the eBay application's daily limit.
