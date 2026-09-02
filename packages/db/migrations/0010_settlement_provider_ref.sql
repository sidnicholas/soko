-- Rail execution: persist the rail's contract/intent reference on the plan so a
-- release can capture/settle against the same prepared reference (§19).
alter table settlement_plans add column if not exists provider_ref text;
