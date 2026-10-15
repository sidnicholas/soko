# ADR-036: P0 stabilization before PRD v2 expansion

- Status: Accepted
- Date: 2026-10-15

## Context

PRD v2 P0 requires: unauthorized REST writes blocked, events replayable
without duplication, noisy graph deals suppressed until real embeddings
exist, inbound abuse limited, and a measured baseline before optimizing.

## Decision

- **Missions are read-only over Supabase REST** (migration 0024): the 0002
  owner insert/update policies are dropped; owner reads stay. Every mission
  write goes through the API. Tested by switching to the `authenticated`
  role in `tests/e2e/rls-rest-roles.test.ts`, since the rest of the suite
  runs as a superuser that row level security never applies to.
- **Outbox relay locks its batch** (`relayOutboxBatch`, `for update skip
  locked`), marks what the publisher accepted before surfacing a failure, and
  stays at-least-once: consumers dedupe on the idempotency key.
- **Cross-entity graph arbitrage is off while embeddings are the echo stub**
  (`GRAPH_ARBITRAGE_DEALS=auto`); when off, open arbitrage deals are expired
  each sweep. Bundles are unaffected.
- **Inbound message rate limit** per sender per hour
  (`INBOUND_MESSAGES_PER_HOUR`, default 20) across Telegram, SMS, email and
  WhatsApp; excess messages are dropped without intake or reply. In memory,
  so per API process.
- **Baseline report** `GET /v1/analytics/yield`: intel spend and yield per
  day and per search provider, and opportunities by kind and status.

## Consequences

Still open for P0 and needing production access: confirm 0022 and apply and
confirm 0024 in Supabase; run `worker-outbox --once` as a Railway cron (it
has no consumers yet, so the gain is a drained, replayable outbox);
verify Stripe, Circle, eBay, Twilio and WhatsApp signatures against real
notifications; test isolation under a least-privilege application role
instead of the table owner.
