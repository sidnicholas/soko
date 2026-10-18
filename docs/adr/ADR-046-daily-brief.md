# ADR-046: Daily brief

- Status: Accepted
- Date: 2026-10-17
- PRD v2 P2 ("operator client brief, daily digest"; gate: briefing source citations)

## Context

The operator needs one place each morning that says what changed: new
actionable candidates, replies to answer, good deals, sources that broke,
and what it cost. P2's gate asks that briefings cite their sources.

## Decision

- **One brief per local day** (`briefings`, migration 0037, unique on
  `brief_date`), covering the 24 hours before it was built. Sections:
  new actionable candidates (act now / verify next, top 8 by score), outreach
  (replies and opt-outs to review, drafts, failures, bounces, counts), good
  deals (deal checks, top 5 by discount), sources (paused in the period,
  failing, actor runs, quarantine) and spend (search and models, Apify,
  against their daily budgets, and cost per actionable candidate).
- **Every item cites**: links to the record in the app (Action Queue,
  conversation, Source Registry, Yield & Spend) and to the outside source
  (the listing, buyer post or counterpart page). Built without a model from
  stored facts (`@opportunity-os/briefing`, pure), so nothing in it is
  invented.
- **Delivery.** Each `worker-lifecycle` sweep builds today's brief once the
  local hour reaches `BRIEF_HOUR` (default 7, `BRIEF_TIMEZONE` else
  `OUTREACH_TIMEZONE`); the unique date means it is built and emailed once.
  When `BRIEF_EMAIL_TO` is set it is emailed as plain text from the outreach
  mailbox (not counted against outreach caps; links made absolute with the
  first `WEB_ORIGINS` entry). `briefing.ready.v1` is emitted.
- **API/UI.** `/v1/briefings` (list, latest, by date; staff), `POST
  /v1/briefings/generate` (operators; rebuilds today's, `?email=true` also
  sends). Page `/brief` ("Daily Brief", first in the sidebar).

## Consequences

- The brief is only as complete as what is stored; a period with a failed
  worker shows low counts rather than an error. Rebuilding replaces the day's
  content.
- Client briefs per counterparty (PRD "client brief") and model-written
  summaries are later.
