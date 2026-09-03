-- Dispute/freeze resolution: remember the status a plan/milestone was in
-- right before it got disputed/frozen, so resolving can restore it instead of
-- only ever refunding (§20 follow-up to ADR-031/ST-11).
alter table settlement_plans add column if not exists pre_dispute_status text;
alter table settlement_plans add column if not exists pre_freeze_status text;
alter table settlement_milestones add column if not exists pre_dispute_status text;
