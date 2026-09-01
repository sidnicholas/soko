# ADR-020: LLM negotiation drafting with template fallback

- Status: Accepted
- Date: 2026-09-01

## Context

§11.2(4)/§13.5 require preparing negotiation drafts for human review while never sending autonomously. `prepareNegotiation` previously persisted an empty draft. V1 runs on the `echo` LLM provider (no real model), and model output cannot be trusted to be schema-valid.

## Decision

`@opportunity-os/negotiation` exposes `draftNegotiation(ctx, gateway)`. It attempts LLM drafting (task class `negotiation_drafting`, output validated against a messages schema, item text fenced as untrusted per §13.3) and falls back to `templateDraft`, a deterministic professional, explicitly non-binding message set built from the opportunity's context (buy/sell side, item title/description, target price, authorized ceiling). The API grounds the draft by joining opportunity → match → demand + supply, records `approved_bounds_json` (target + ceiling), stores the drafts on the negotiation row (state `draft`), and emits `negotiation.draft_ready.v1`. Nothing is sent — sending remains gated behind `negotiation:send` + an approval token (§14/ADR-019).

## Consequences

Real draft content with or without a model; the template backbone is deterministic and unit-testable offline. Drafts stay advisory: `maySend` is never set here. When a production model profile replaces `echo`, drafts improve with no interface change. Approved bounds captured now feed later negotiation-send gating.
