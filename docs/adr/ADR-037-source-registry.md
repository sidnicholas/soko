# ADR-037: One source registry with a permission-policy gate

- Status: Accepted
- Date: 2026-10-16

## Context

PRD v2 FR-01 requires a source registry: identity, market, orientation, API
availability, Apify actor and version, permission basis, robots/terms
assessment, data-use constraints, review dates, contact path, frequency,
cost, yield, health and auto-pause; and "a source cannot activate until
permission policy is satisfied". Three partial registries existed:
`intel_query_sources` (runtime sources, active on arrival with no review),
the built-in venue list in `packages/intel/src/queries.ts`, and the
connector list in `worker-connectors`. PRD §7 forbids duplicate truth tables.

## Decision

- **One table, `source_registry`** (migration 0025): `intel_query_sources`
  renamed in place, so its rows and ids survive, with the FR-01 fields added.
  The built-in venues and the eBay and Reverb connectors become rows
  (origins `builtin`, `connector`). `kind` is `search_venue`, `connector` or
  `apify_actor`; uniqueness is (kind, domain, orientation).
- **History beside it:** `source_policy_reviews` (append-only, every review
  decision) and `source_runs` (every search or connector call, with results,
  leads, cost and error).
- **Deterministic policy** (`packages/intel/src/source-policy.ts`,
  `source-policy-1`): runnable only with an allowed permission basis for the
  kind, a robots/terms assessment and an unexpired review. A search index
  clears a search venue (the site is never fetched); a connector needs
  official API terms or stronger; an Apify actor needs written permission,
  a provider contract or official API terms, data-use constraints, and a
  pinned actor id and version (PRD §3.6).
- **Lifecycle:** screening (`vetSource`) can only make a submission
  `proposed`, `paused` or `rejected`. A review by a person with the new
  `source:review` permission (operator, admin; never agents) activates a
  source when the policy then holds. Each run re-checks the policy (a lapsed
  review pauses the source), skips sources inside their minimum interval or
  over their daily cap, and afterwards pauses search venues that are failing
  (three consecutive errors) or whose every query has been searched three
  times with no lead. Built-in venues follow the same rules.
- **Atomicity:** every submission, review, activation and pause commits the
  registry change, a hash-chained audit event and an outbox event
  (`source.reviewed.v1`, `source.activated.v1`, `source.paused.v1`) in one
  transaction.
- **Compatibility:** a `security_invoker` view named `intel_query_sources`
  keeps code deployed before the migration working (anon and authenticated
  revoked). `/v1/intel/sources` stays as an alias of `/v1/sources`.

## Consequences

- Built-in venues and connectors were recorded as reviewed by the migration
  ("migration 0025") with a 180-day due date; an operator re-reviews them in
  the Source Registry before then.
- Submissions no longer run on arrival; someone must review them.
- Apify ingestion, `source_observations` and `ingestion_quarantine` were
  added with the Apify slice (P1 slice 4, ADR-042).
- A later migration drops the compatibility view once the code using
  `source_registry` is deployed.
- `intel_sources` remains the yield of hosts leads came from; per-source
  yield now comes from `source_runs`.
