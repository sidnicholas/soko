-- Phase 2 human-controlled execution: track approval-request delivery so the
-- notifications worker delivers each pending approval exactly once (§14).
alter table approvals add column notified_at timestamptz;

create index approvals_undelivered_idx
  on approvals (expires_at)
  where status = 'pending' and notified_at is null;
