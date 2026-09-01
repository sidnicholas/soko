-- §22/§962 — Row Level Security for user-facing tables. Domain authorization
-- remains application-owned; RLS is defense-in-depth for the Supabase path.
-- Assumes Supabase-style auth.uid() returning the current user's UUID.

alter table missions enable row level security;
alter table mission_versions enable row level security;

-- Owners can read their own missions.
create policy missions_owner_select on missions
  for select using (owner_user_id = auth.uid());

-- Owners can create missions for themselves.
create policy missions_owner_insert on missions
  for insert with check (owner_user_id = auth.uid());

-- Owners can edit their own missions (status/title/intent); history is protected below.
create policy missions_owner_update on missions
  for update using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

-- Mission versions are readable by the owning mission's owner.
create policy mission_versions_owner_select on mission_versions
  for select using (
    exists (
      select 1 from missions m
      where m.id = mission_versions.mission_id and m.owner_user_id = auth.uid()
    )
  );

-- A user can create a new version for a mission they own...
create policy mission_versions_owner_insert on mission_versions
  for insert with check (
    exists (
      select 1 from missions m
      where m.id = mission_versions.mission_id and m.owner_user_id = auth.uid()
    )
  );

-- ...but cannot mutate prior MissionVersion records (§22): no UPDATE/DELETE policy is granted,
-- so RLS denies those operations to non-privileged roles by default.

-- Service/agent backend roles bypass RLS via the service_role key and enforce
-- authorization in the application policy layer (packages/auth).
