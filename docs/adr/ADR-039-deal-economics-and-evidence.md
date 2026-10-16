# ADR-039: Delivered-cost deal economics and captured evidence

- Status: Accepted
- Date: 2026-10-16

## Context

PRD v2 FR-04 asks for delivered cost — tariffs and taxes, insurance, FX,
payment and escrow fees, returns, chargebacks, freight, financing,
commissions — a gate on negative net economics and unmanageable capital, and
a default ranking of net-profit tiers, then probability of close, then time
to close, with uncertainty shown and an expected-value alternative. §2 adds:
show profit, probability and time separately; never rank on a headline
spread; distinguish gross revenue, gross spread, net profit, capital,
probability-adjusted profit and time to cash. §7 names
`opportunity_evidence` and `opportunity_economics_versions`; §8 names
`opportunity.economics_updated`; §15 requires that "a $100,000 headline
spread with $110,000 landed costs is not ranked as profitable". The P1 gate
asks for reproducible lead evidence.

## Decision

- **One deterministic engine** (`packages/scoring/src/deal-economics.ts`,
  `deal-economics-1`) for three modes: brokerage (fee or commission),
  principal (buy and resell) and service. The model supplies cost lines it can
  identify, each labelled `source_fact` or `estimate`; the engine fills the
  missing ones from stated assumptions (`default_assumption`: payment fees
  2–3.5%, and for principal deals freight 5–15%, returns 1–4%, chargebacks
  0–1%; FX 1–3% across currencies; financing 12% a year on capital until
  cash), then computes net profit as a range (least revenue minus most cost,
  and the reverse), probability-adjusted profit, days to cash and a tier
  (high ≥ $1,000, medium ≥ $250, low ≥ $50, marginal > 0, negative).
- **Gates:** net profit at or below zero at its best rejects the candidate
  (`negative_net_economics`); capital above `DEAL_MAX_CAPITAL_USD` (default
  $1,000 until the operator sets exposure caps, PRD §17) holds it at WATCH
  (`capital_exposure`). EV and score use net profit, not compensation.
- **Ranking** (`rankDeals`): `profit_first` (default), `expected_value`,
  `fastest_cash`; gated deals always last. The Action Queue orders each
  bucket by the chosen profile (`GET /v1/intel/queue?rank=`).
- **Versioned economics:** every assessment appends a numbered row to
  `opportunity_economics_versions` (inputs, outputs, model version) and the
  candidate keeps the latest copy; `opportunity.economics_updated.v1` is
  emitted in the same transaction (the PRD's name, not `score_changed`, since
  intel candidates are not opportunities yet).
- **Captured evidence:** `opportunity_evidence` stores, at capture time, the
  lead's search result and labelled facts, and for a candidate the counterpart
  result used and the contact path — each with a SHA-256 content hash, so the
  basis of a decision can be reproduced if the page changes. Identical rows
  are stored once per subject.

## Consequences

- Candidates assessed before this have no delivered-cost economics; they rank
  after those that do until re-assessed.
- Mission and graph opportunities still use the older `computeEconomics`;
  for mission opportunities the user is the buyer (savings, not profit). The
  engine and both tables accept `opportunity` subjects for when they move over.
- Default assumptions are visible on every cost line so an operator can see
  which part of a net figure is assumed rather than stated.
