-- Close the Supabase REST write path to missions (PRD v2 P0, §10).
--
-- 0002 gave a signed-in owner insert and update policies on missions and an
-- insert policy on mission_versions. Supabase's authenticated role reaches
-- those tables through its REST API with the anon key from the web bundle, so
-- an owner could create or edit missions there without the API's validation,
-- versioning, audit or outbox events. Nothing uses that path: the web app
-- uses Supabase for sign-in only, and the API and workers connect as the
-- table owner, which row level security does not apply to.
--
-- The owner read policies stay. Writes now have no policy, so those roles can
-- write no rows; every mission change goes through the API.
drop policy if exists missions_owner_insert on missions;
drop policy if exists missions_owner_update on missions;
drop policy if exists mission_versions_owner_insert on mission_versions;
