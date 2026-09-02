-- ST-11: dispute/freeze/refund need their own timestamps + a terminal
-- REFUNDED milestone status; SettlementStatus itself is free text (no check
-- constraint) so the new REFUNDED plan status needs no DDL beyond this.
alter table settlement_plans add column if not exists disputed_at timestamptz;
alter table settlement_plans add column if not exists frozen_at timestamptz;
alter table settlement_plans add column if not exists refunded_at timestamptz;

alter table settlement_milestones add column if not exists disputed_at timestamptz;
alter table settlement_milestones add column if not exists refunded_at timestamptz;
alter table settlement_milestones add column if not exists external_refund_ref text;

alter table settlement_milestones drop constraint if exists settlement_milestones_status_check;
alter table settlement_milestones add constraint settlement_milestones_status_check
  check (status in ('pending','verified','released','disputed','refunded'));
