# ADR-018: Demand parser — LLM extraction with deterministic fallback

- Status: Accepted
- Date: 2026-09-01

## Context

§3.1(3)/§7 require structuring natural-language buyer intent into a validated DemandSpecification. Mission creation and public intake both need this. V1 runs on the `echo` LLM provider in dev/CI (no real model), and model output cannot be trusted to always be schema-valid JSON.

## Decision

`@opportunity-os/demand` exposes `parseDemand(input, gateway)`. It attempts LLM extraction via the gateway (`extraction` task class, output validated against the DemandSpecification zod schema, user text passed as fenced untrusted context per §13.3). Any failure — provider unavailable, budget/timeout, or non-schema output — falls back to `heuristicDemandSpec`, a deterministic regex/keyword extractor (description, `$` budget with ceiling cues, urgency/fulfillment keywords, category keyword → quality constraint). Explicit form hints (budget max, urgency, needed-by, currency) always override inferred values. The heuristic never invents budgets or dates absent from the text.

## Consequences

Structuring works with or without a real model; the heuristic is the reliable backbone and is fully unit-testable offline. Mission `demand_spec` is now optional on create — omit it to structure `raw_intent` automatically. Public intake forces `negotiationAuthorization` off regardless of parse output. Category inference feeds `projectMissionDemand`, improving match gating. Heuristic coverage is intentionally narrow (US English, common categories); precision improves when a production model profile replaces `echo`.
