# Temporal (§11, ADR-006)

Local dev uses `infra/docker/docker-compose.yml` (auto-setup image, UI on :8088).
Production uses Temporal Cloud or a self-hosted cluster; set:

    TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE

Workflows and activities live in `apps/worker-temporal`.
