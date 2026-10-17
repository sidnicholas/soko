# ADR-043: Owner risk acceptance for Apify actors without site permission

- Status: Accepted
- Date: 2026-10-17
- Product owner decision; exception to PRD v2 §1 principle 6 and FR-01

## Context

The product owner wants to run `apify~facebook-marketplace-scraper`. Meta's
terms prohibit automated collection without its written permission, there
is no Marketplace listings API, and Meta pursues scrapers in court. The
owner was told this and chose to accept the legal exposure (2026-10-17).
Under ADR-037/042 the only way to run the actor would be to record a
permission basis that is not true, which would make the review history
false.

## Decision

- **New basis `owner_risk_acceptance`** (migration 0032,
  `source-policy-2`), allowed for `apify_actor` sources only. It states that
  no permission exists and the owner runs the source anyway.
- **Admin only:** approving with it needs the new `source:accept_risk`
  permission (admins; never operators or agents) and a note saying what
  risk is accepted and why.
- **At most 90 days:** a review with this basis whose validity runs longer
  than 90 days leaves the source `proposed` (`risk_acceptance_over_90_days`);
  the default due date for it is 90 days. Someone must accept it again to
  keep it running.
- **Everything else still applies:** pinned build, data-use constraints,
  quarantine, budgets, backoff and auto-pause (ADR-042). The review and the
  activation are in `source_policy_reviews`, the audit chain and
  `source.reviewed.v1` / `source.activated.v1`.
- **Data minimization for marketplace actors:** the field map should not
  map seller identity (`sellerName`, `sellerUrl`) when sellers are private
  individuals; listings are kept as item, price, location and link.

## Consequences

- The legal and account risk (terms-of-service claims, IP blocking, Apify
  account action) sits with the business, by the owner's explicit decision.
- The registry stays truthful: reports can list every source running on
  risk acceptance rather than permission.
- PRD v2's "vetted sources only" P1 gate should be read with this exception
  noted.
