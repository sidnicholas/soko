-- Wiring missionDiscoveryWorkflow into live traffic: a mission with a running
-- workflow is excluded from worker-lifecycle's own sweep (listActiveMissionsForDiscovery)
-- so the two schedulers never double-drive the same mission.
alter table missions add column if not exists temporal_workflow_id text;
