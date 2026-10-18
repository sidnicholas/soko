# ADR-047: Follow-ups and the closed archive

- Status: Accepted
- Date: 2026-10-18
- PRD v2 FR-07/FR-14 (P2); builds on ADR-035 (Action Queue), ADR-045 (outreach), ADR-046 (daily brief)

## Context

The Action Queue had "Mark contacted" and "Got a response", but a candidate
marked contacted stayed in Act now / Verify next indefinitely, with no age,
no reminder to follow up and no end. Won, lost and dismissed candidates
disappeared from view. The product owner asked for contacted items to move
somewhere they age, with periodic reminders based on common practice.

## Decision

- **Where they go.** The Action Queue shows only `open` candidates.
  Contacted and responded ones are worked from **Follow-ups** (`/follow-ups`);
  won, lost and dismissed ones are the **Closed** archive on the same page,
  with reason, note, revenue, touch count and Reopen (back to the queue).
- **Touches** (migration 0038, `candidate_touches`): first contact, follow-up,
  response and note, each with channel and optional note. Logged by the
  status buttons, by hand ("Log follow-up", "Add note"), and by outreach: an
  approved email about the candidate is the first contact or a follow-up
  when sent, and a reply filed in its conversation is a response (logged
  once per message via `ref_id`). A first contact or follow-up makes an open
  candidate contacted; a response makes it responded.
- **Ageing.** `intel_candidates.status_changed_at` is kept by a trigger on
  `user_status` (every writer, including Pipedrive sync); `updated_at` could
  not be used because each intel run re-scores candidates.
- **Cadence** (`followUpPlan`, pure, in `@opportunity-os/relationship`),
  following common outreach practice: several touches over a few weeks with
  growing gaps, each adding something new, ending with a polite last note.
  - Marketplace candidates (an item bought or sold; they move in days):
    follow-ups on days 1, 3 and 6 after first contact, cold 4 days after the
    last one.
  - Business offers (`problem_to_service`): days 3, 7 and 14, cold 7 days
    after the last one.
  - Always at least a day after the previous touch.
  - Responded: propose the next concrete step within 2 days of the last
    exchange; stalled after 14 days without one.
  - Each step shows what to say (bump with a yes/no question; add something
    new or a second channel; last note).
  - Stages: due, upcoming (waiting), cold, stalled. Cold and stalled are
    never closed automatically: the outcome reason is a learning signal and
    stays a person's call ("Close as lost…" defaults to `no_response`).
- **Snooze.** "Remind me in 1d/3d/1w" sets `snoozed_until`; doing the
  follow-up or a status change clears it.
- **Reminders.** The daily brief (ADR-046) leads with a Follow-ups section
  (due, stalled, gone cold, each linking to `/follow-ups#id`) and its
  headline counts follow-ups due; the Action Queue shows the counts with a
  link.
- **API:** `GET /v1/intel/follow-ups`, `GET /v1/intel/closed?status=`,
  `POST /v1/intel/candidates/:id/touches`, `POST /v1/intel/candidates/:id/snooze`.
  Touches are audited (`intel.touch.*`).

## Consequences

- Nothing contacted is forgotten: it is either due, waiting, cold, stalled or
  closed with a reason.
- Calendar days, not business days; the schedule is fixed in code, not per
  user, until there is outcome data to tune it (P5 calibration).
- Touches on channels outside the app (phone, marketplace messages) depend on
  the operator logging them.
