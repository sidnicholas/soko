# ADR-038: Independent supply and demand intelligence

- Status: Accepted
- Date: 2026-10-16

## Context

PRD v2 FR-02 asks for supply intelligence that captures surplus, liquidation,
capacity, price breaks, MOQ, condition and shipping terms, separates
verified listings from inferred surplus, keeps evidence and last-seen times,
and never assumes liquidation means clear title. FR-03 asks for demand
intelligence that labels observed facts versus inferred intent, requires
evidence before outbound claims, sends unmet demand to targeted supplier
discovery and unmatched supply to buyer search, and keeps watchlist
hypotheses with revisit and expiry rules. §5 lists `worker-supply` and
`worker-demand`; §15 requires that "a hypothetical demand precursor cannot be
represented as a confirmed buyer".

## Decision

- **Leads stay canonical** (migration 0026). `intel_leads` gains
  `signal_type`, `evidence_level` (observed / inferred), `supply_terms`,
  `title_unverified`, `last_seen_at` and `seen_count`, and the counterpart
  search state. No parallel signal table.
- **Implied demand is a hypothesis, not a lead.** Detection lists precursors
  (hiring, expansion, projects, recurring consumption, procurement cycles,
  substitution, demand creation) separately, and code routes any demand or
  problem lead marked inferred to `demand_hypotheses` too
  (`routeSignal`). Hypotheses never reach the action queue or the
  opportunity feed. Each is revisited every `revisit_days` with one search;
  only an observed lead found that way confirms it; it expires after four
  revisits, within 30–90 days.
- **Evidence rules** (`packages/intel/src/intelligence.ts`): an inferred
  signal is capped at WATCH (`surplus_inferred` / `intent_inferred`) and gets
  no outreach draft. Liquidation and distressed stock carries a
  `title_unverified` flag that keeps it out of ACT NOW.
- **Counterpart discovery is its own stage**, budgeted per run
  (`INTEL_COUNTERPART_SEARCHES`, default 4): suppliers for demand, buyers for
  supply, providers for problems. Results are stored on the lead; assessment
  reuses them and ranks two-sided matches first. One retry after three days
  when nothing is found. Government notices are screened before it.
- **Independent schedules, one codebase.** `worker-intel --lane=demand`
  (demand and problems, plus the watchlist) and `--lane=supply` run as two
  Railway cron services. The daily cap stays a single ceiling across both
  (ADR-035); `INTEL_RUNS_PER_DAY` counts runs of both lanes. Two apps with the
  same code would add nothing (ADR-033).
- **Events:** `surplus.detected.v1` with each new supply lead and
  `signal.hypothesis_created.v1` with each hypothesis, in the same
  transaction as the insert.
- **Surfaces:** `GET /v1/supply-intelligence`, `GET /v1/demand-intelligence`
  (leads plus watchlist), `POST /v1/demand-intelligence/hypotheses/:id/status`
  (`outcome:record`, never agents); Surplus Supply and Emerging Demand pages.

## Consequences

- Each run spends a little on counterpart searches and revisits before
  assessment; both are inside the daily cap.
- Hypothesis revisits and status changes are recorded on the row (`checks`,
  `status_reason`) rather than as audit events; they move no money and bind
  nobody.
- Per-lead evidence records and landed-cost economics come with P1 slice 3.
