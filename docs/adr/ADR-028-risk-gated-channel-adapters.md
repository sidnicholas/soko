# ADR-028: Risk-gated channel adapters

- Status: Accepted
- Date: 2026-09-01

## Context

ADR-022 framed multi-channel ingestion (official APIs, browser extension, crawl, feeds). V1 must never build around prohibited scraping (§17/ADR-014), and connector content is untrusted data, never instructions (§13.2/§13.3). Ingestion needs real adapter shapes plus enforced gates.

## Decision

- **Adapter framework** (`connectors-sdk`): `makeHttpApiConnector` (official API / licensed feed → JSON → observations) and `makeCrawlConnector` (permitted public fetch → text → observations). Both take an injectable `fetch`, so they are keyless/offline-testable and key-ready in prod. Browser-extension is a push channel via `POST /signals`.
- **Policy gate**: `isAutomationPermitted(policy)` — `official_api`, `licensed_feed`, `authorized_user_connection` always permitted; `permitted_public_fetch` only when `respects_robots`; `manual_human_assisted` never runs unattended.
- **Risk gate** on ingestion (`worker-connectors/ingest.ts`): skip non-permitted connectors; drop observations whose category is not transactable in V1 (`isTransactableInV1`) or that contain prompt-injection (`detectInjection`); persist the rest.
- **Signal intake gate**: `POST /signals` rejects instruction-like content (`detectInjection`) before capture.

## Consequences

Real, testable adapters now; live sources plug in by passing production `fetch` + credentials + a `mapResponse`/`parse`. Gates are deterministic and auditable. Conservative default: unknown categories classify as review-required and are dropped by unattended ingestion (a human/operator path can still admit them). robots/ToS remain per-source policy; the framework refuses prohibited automation rather than trusting callers.
