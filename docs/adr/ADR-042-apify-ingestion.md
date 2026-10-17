# ADR-042: Apify ingestion — actor runs, observation ledger and quarantine

- Status: Accepted
- Date: 2026-10-17
- PRD v2 FR-01 (P1 slice 4); extends ADR-037

## Context

PRD v2 FR-01 asks for Apify dataset ingestion with webhook signatures, job
status, backoff, duplicate avoidance, budgets and quarantine for unexpected
fields, and §15 asks that a listing seen through Apify and through an
official API merge into one entity without losing provenance. ADR-037 already
lets an `apify_actor` source run only with written permission, a provider
contract or official API terms, data-use constraints and a pinned actor and
build. Apify documents ad-hoc run webhooks with a custom headers template but
no request signature; its guidance is a secret only the receiver knows.

## Decision

- **Actor sources** are `source_registry` rows of kind `apify_actor`
  (migration 0031 adds input, field map, expected fields, items and cost per
  run). Staff register them (`POST /v1/ingestion/apify/sources`); they arrive
  `proposed` and run only after a policy review. "latest" is not a pinned
  build. Changing the actor or build of an active source sends it back to
  `proposed` for a new review; other configuration changes need
  `source:review`.
- **Running** (`worker-connectors`, each sweep, and "Run now"): a source
  starts only when the policy holds, its interval has passed (Run now skips
  only this), no run of it is open, its backoff has expired, and there is
  budget. The run's `maxTotalChargeUsd` is the smallest of the per-run cap,
  what is left of the source's daily cap and what is left of
  `APIFY_DAILY_BUDGET_USD` (default $1), counting open runs at their caps;
  under $0.01 it does not start. Items per run: at most the source's limit
  and never over 1,000.
- **Completion**: each run carries an ad-hoc webhook to
  `POST /v1/webhooks/apify` whose headers template sends
  `x-apify-webhook-secret` (`APIFY_WEBHOOK_SECRET`, constant-time compare).
  Nothing in the body is trusted: the run id must be one we started
  (`apify_runs`) and its status, dataset and cost are read back from Apify.
  `worker-connectors` polls open runs as the fallback. Whichever claims a
  finished run first ingests it (`status running → ingesting`, a claim older
  than 30 minutes is retaken); the other sees `already_handled`.
- **Items** are untrusted data. The source's field map names which item path
  (or `const:` value) is the id, title, description, link, price (major or
  minor units), currency, category, quantity, condition, seller and
  location; nothing else is read. Markup is stripped, links must be http(s).
  Quarantined (`ingestion_quarantine`) instead of ingested: fields the actor
  did not return before (the first run, when the reviewer gave none, sets
  the expected fields), a missing id or title, an unreadable price, a
  category that does not map to a known one (PRD §3.4 default deny), text
  that looks like prompt injection. A person (`source:review`) can release
  an item held for new fields — once, or accepting the fields for the source
  — or discard any item. A field map's `categoryMap` turns the source's own
  category values (Facebook category ids, a site's labels) into ours; a
  value it does not know is held as `category_unmapped`, and mapping it from
  the quarantine saves it in the map and releases every item held for that
  value. Other holds cannot be released because they would fail the same
  check. `dropFields` removes personal fields before anything is kept.
- **Observation ledger** (`source_observations`, every source): one row per
  source and item with its content hash, the listing's canonical key
  (host + path; eBay items by item number) and the supply row it fed. A
  repeat with the same hash only refreshes "seen"; a new item whose key
  matches a listing first stored through another source is merged into that
  supply row (marked `merged`, provenance kept), so an official-API listing
  and the same listing from an actor are one entity. The eBay and Reverb
  connectors write the ledger too, so merges work in both directions.
  Demand items are kept as observations only.
- **Failures**: a failed, timed-out or aborted run (or one that could not
  start) records a `source_runs` error with its cost, delays the next start
  by 15 minutes doubling per consecutive failure (at most a day), and after
  three consecutive failures pauses the source (`source.paused.v1`, reason
  `failing`). A success resets the streak. Costs are Apify's
  `usageTotalUsd` and count in the source registry's spend and yield.
- **UI**: Source Registry gains "Register an actor", the actor's
  configuration and runs in its detail, "Run now", and a Quarantine card.

## Addendum: search plans (2026-10-17, migration 0033)

A source may carry a search plan instead of a fixed input: a URL template
with `{city}` and `{query}`, cities, a keyword list, `fromDemand`, searches
per run (≤ 20) and the item field naming the search that found it
(Facebook: `facebookUrl`). Each run builds its URLs: the `item` of observed
demand leads from the last 7 days first (up to 60% of the run when a list
exists), then keyword × city in rotation, never-searched first, then
longest ago. A search run in the last 24 hours is skipped; one that found
nothing new three times running waits 7 days and then goes last. Each run's
searches are stored (`apify_run_searches`) and credited with the items and
new items they found. With nothing due, no run starts (`no_searches_due`).

## Addendum 2: buyer items become demand leads (2026-10-17, migration 0035)

Actor sources can carry buyers: Alibaba RFQs (a demand source) and
Craigslist "WANTED" posts mixed into a supply source. A field map may set
`demandTitlePattern` (titles matching it are buyers whatever `kind` says),
map `deadline` and `quantityUnit`, declare the buyers' `signal` (rfq,
purchase_request, …), and set `categoryFromTitle` (a supply item with no
usable category takes one from its title's words). Each sweep,
`worker-connectors` raises buyer items from actor sources as demand leads
(`DEMAND_LEADS_PER_RUN`, default 25; once each, recorded on the
observation; expired requests skipped): the request, quantity, buyer
location and deadline as facts, supplier searches for the counterpart
stage, urgency high when it closes within a week. The demand lane assesses
them like any lead, and their items steer the marketplace search plans.

## Consequences

- No actor is registered: each needs the owner to choose a site, obtain its
  written permission (or use an official API under its terms), and review it.
- Apify's webhook secret travels in the run definition stored at Apify;
  rotate it by changing `APIFY_WEBHOOK_SECRET` on both services (runs started
  before still carry the old one and are picked up by the poller).
- Merging is by URL identity only; the same item listed twice by a seller
  under different URLs is not merged.
- A dedicated `worker-ingestion` (PRD §5) can take this over when volume
  needs it; the code lives in `packages/intel` and `packages/db`, not in the
  worker.
