-- Phase 4: mission sharing (collaborators) + user->agent steering.

-- A mission is owned by missions.owner_user_id; these rows grant other users
-- access to it. Revoking deletes the row — the mission.unshared.v1 outbox
-- event is the durable record that access once existed.
create table if not exists mission_shares (
  id          uuid primary key default gen_random_uuid(),
  mission_id  uuid not null references missions(id) on delete cascade,
  user_id     uuid not null references users(id),
  role        text not null check (role in ('viewer', 'editor')),
  granted_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  unique (mission_id, user_id)
);
create index if not exists mission_shares_user_idx on mission_shares(user_id);

-- Why a user (or steering) set an opportunity aside. Status stays the domain's
-- terminal 'rejected'; discovery upserts must not resurrect it.
alter table opportunities add column if not exists rejection_reason text;
alter table opportunities add column if not exists rejected_by text;
alter table opportunities add column if not exists rejected_at timestamptz;
