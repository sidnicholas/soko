-- Phase 1 ingestion loop: idempotent upsert targets so re-running discovery
-- refreshes rows in place instead of duplicating them (§11.1 discover->match->score).
--
-- These indexes rely on Postgres treating NULLs as distinct in unique indexes:
-- mission-derived demands (external_ref NULL) never collide on the source key,
-- and source rows (mission_id NULL) never collide on the mission key.

-- Source rows are identified by (source_id, external_ref); connectors re-emit the
-- same external_ref every refresh cycle.
create unique index supply_source_uidx on supply (source_id, external_ref);
create unique index demands_source_uidx on demands (source_id, external_ref);

-- A mission owns exactly one derived demand (its current demand_spec), upserted
-- on every discovery cycle.
create unique index demands_mission_uidx on demands (mission_id);

-- One opportunity per match; re-scoring updates the existing row.
create unique index opportunities_match_uidx on opportunities (match_id);
