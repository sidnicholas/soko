# ADR-040: Pipedrive as the CRM for elevated deals

- Status: Accepted
- Date: 2026-10-16
- Outside PRD v2 (product owner request, 2026-10-16)

## Context

The operator wants to work promising deals in Pipedrive: elevate an Action
Queue candidate into a Pipedrive deal, then have Pipedrive report progress
back so Opportunity OS stays current. Pipedrive documents deals on API v2
(`POST /api/v2/deals`), notes and webhooks on v1, the API token in the
`x-api-token` header, and webhook v2 deliveries (`meta` / `data` / `previous`)
authenticated only by optional HTTP basic auth, retried at 3, 30 and 150 s,
banned for 30 minutes after 10 first-attempt failures and deleted after 3 days
without a success.

## Decision

- **Opportunity OS stays the system of record** for discovery, evidence and
  economics; Pipedrive holds the sales work. `crm_links` (migration 0029)
  maps a subject (intel candidate now; opportunities and off-network deals
  allowed by the schema) to its Pipedrive deal.
- **Elevate** (`POST /v1/crm/pipedrive/candidates/:id`, `outcome:record`,
  never agents): the link row is reserved first, so a subject is elevated
  once; the deal is created with the candidate's title, value = middle of the
  net-profit range (not the headline amount, ADR-039), USD, the expected close
  date from days-to-cash, and the configured pipeline/stage. A note carries
  the signal, the other side, how we get paid, the economics with each cost
  line, contact path, flags, evidence links and a link back. A failed note
  does not lose the deal; a failed deal releases the reservation. Commits the
  link with an audit event and `crm.deal_elevated.v1`.
- **Webhook** (`POST /v1/webhooks/pipedrive`): basic auth against
  `PIPEDRIVE_WEBHOOK_USER` / `PIPEDRIVE_WEBHOOK_PASSWORD` (constant-time),
  deal events only. Each event id is applied once (`crm_webhook_events`); an
  event older than the last applied one changes nothing. Won → candidate won,
  deal value as realized revenue when USD; lost → candidate lost with the
  Pipedrive lost reason as its note; open (new or reopened) → contacted;
  deleted → link marked deleted. Commits with an audit event and
  `crm.deal_synced.v1`. Unknown deals and other entities are acknowledged
  with 200 so Pipedrive never bans the webhook.
- **Setup without handling the token outside the API:** `POST
  /v1/crm/pipedrive/webhook` (new admin-only `crm:configure`) registers the
  webhook from the API's own configuration; the Settings page shows status
  and a Register button.

## Consequences

- Pipedrive's basic auth travels over HTTPS only; the credentials are ours to
  rotate (re-register after changing them).
- Persons and organizations are not created in Pipedrive yet: most leads have
  no named contact. Add when contacts are resolved (PRD v2 FR-06).
- Non-USD deal values are noted on the candidate but not counted as realized
  USD revenue.
