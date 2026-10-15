# ADR-035: Opportunity intelligence (AIOOS) pipeline and its cost controls

- Status: Accepted
- Date: 2026-10-15 (records decisions made 2026-10-03 to 2026-10-15)

## Context

The extended PRD (`docs/Opportunity_OS_AIOOS_Master_Prompt.md`) asked for
web-sourced opportunity intelligence. The decisions were recorded only in
`docs/Opportunity_OS_AIOOS_Gap_Analysis.md` and the project memory.

## Decision

- **Pipeline:** search → model detection → screening → opposite-side search
  → model assessment → deterministic rules (verification ladder, freshness,
  regulatory and fraud screens, why-paid gate, expected value, score,
  bucket). Models estimate; `packages/intel/src/rules.ts` decides (ADR-015).
- **Providers:** Claude through the gateway (fast tier for detection,
  reasoning tier for assessment) and Brave search. Since 2026-10-15 each is
  swappable by configuration: Serper for search, an OpenAI-compatible host
  for either model tier. A model tier without a configured price is refused,
  because spend caps depend on it.
- **Spend:** a hard daily cap (`INTEL_DAILY_BUDGET_USD`, $1) paced across
  runs; every paid call is checked before and recorded after, failed calls
  included.
- **Screening before paid calls:** government procurement, already-seen URLs,
  prompt-injection hits and reference/news/retail hosts are dropped without a
  model call.
- **Runtime sources:** vetted `site:` sources can be added without a deploy
  and pause themselves after repeated zero yield.

## Consequences

Cost per actionable lead, not the cap, is the measure to improve;
`GET /v1/analytics/yield` reports it per day and per search provider so a
provider switch can be compared against the baseline before it is kept.
