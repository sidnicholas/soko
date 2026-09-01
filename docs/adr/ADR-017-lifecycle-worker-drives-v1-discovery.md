# ADR-017: Lifecycle worker drives V1 discovery

- Status: Accepted
- Date: 2026-09-01

## Context

Phase 1's exit criterion requires opportunities to enter, match, score, refresh, and appear automatically (§27, §11.1(10)). The durable driver is the Temporal `missionDiscoveryWorkflow`, but a Temporal cluster is not provisioned in local/CI or the initial Railway deploy, so nothing yet re-drives discovery on a cadence. Availability/lifecycle refresh (§3.1(9)) also needs a periodic owner.

## Decision

For V1 the `worker-lifecycle` process is the active scheduler. Each sweep it (1) refreshes availability — expire opportunities past `expires_at`, expire demands past `needed_by`, retire supply not re-observed within `SUPPLY_STALE_MINUTES` — then (2) re-drives discovery for every active mission. The discovery pipeline lives in `@opportunity-os/discovery` (`runDiscoveryCycle` + `projectMissionDemand`); the Temporal activity delegates to the same function, so there is exactly one discovery implementation and no logic divergence. Sweeps are idempotent (upserts keyed on natural keys), so overlapping runs cannot duplicate rows.

## Consequences

Autonomy without a Temporal dependency; the whole loop is DB-testable. When Temporal is provisioned it becomes the per-mission durable driver (pause/resume/archive signals); the lifecycle worker's discovery step must then be gated off (config flag) to avoid double-driving, leaving it responsible only for availability refresh. Interval reuses `MISSION_REFRESH_INTERVAL_MINUTES`; staleness via `SUPPLY_STALE_MINUTES` (default 1440).
