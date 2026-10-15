# ADR-034: Operator-signed bounded delegation (design, not built)

- Status: Proposed
- Date: 2026-10-15

## Context

Every binding action today needs a human approval token bound to the exact
terms (ADR-009, ADR-019), and the proposer cannot approve. PRD v2 §3.3 and
§9 ask for a later, controlled way to let routine actions (follow-up
outreach, nonbinding negotiation inside limits) proceed without a per-action
click, without weakening that invariant.

## Decision (proposed)

- A **grant** is a row in `authorization_grants`, created only by a human
  operator through the API: action class, scope (counterparty, category,
  channel, template), limits (per-use amount, total budget, use count,
  exposure ceiling), validity window, and revocation. It is hash-chained into
  the audit log like an approval.
- A delegated action is decided by **deterministic code** in the API: the
  command's terms are checked against an active grant; on a pass, the API
  mints a single-use token for exactly those terms under a distinct service
  principal and records the use in `authorization_grant_uses` (unique per
  command idempotency key, so a retry cannot spend the grant twice).
- **Never delegable:** approving one's own grant, money release on a live
  rail, signing, assuming title or capital, disclosing identities without
  fee protection, first contact with a new counterparty. Those keep the
  per-action human token.
- Global ceilings (aggregate exposure, daily spend, loss) and a kill switch
  sit above every grant.

## Consequences

Not implemented. It starts no earlier than P2 (outreach), after the P0 and
P1 gates pass and the operator sets the caps in PRD §17. Its tests must
include PRD §15's "an agent cannot mint and approve its own authorization;
expired or revoked delegation is denied".
