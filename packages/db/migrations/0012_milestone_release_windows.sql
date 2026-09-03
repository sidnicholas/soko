-- ST-13/WF-3: persist the optimistic-release and deadman-refund windows so the
-- release engine's decideRelease() optimistic/deadman branches (already pure
-- logic in packages/escrow) can be driven by real timestamps instead of being
-- dead code behind a hardcoded conditionSatisfied=true.
alter table settlement_milestones add column if not exists optimistic_after_at timestamptz;
alter table settlement_milestones add column if not exists deadman_at timestamptz;
