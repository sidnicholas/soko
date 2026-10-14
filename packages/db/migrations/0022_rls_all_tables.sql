-- Row level security on every table that did not have it.
--
-- Supabase serves the public schema through its REST API and, by default,
-- grants its anon and authenticated roles full rights on new tables there. The
-- anon key ships in the web bundle, so a table without row level security can
-- be read and written by anyone, around the API and its authorization. Only
-- missions, mission_versions (0002), offnetwork_matches (0020) and
-- intel_query_sources (0021) had it; the user's check of the production
-- database on 2026-10-13 found the other tables exposed.
--
-- No policy is added: with row level security on and no policy, those roles
-- see no rows and can write none. The API and workers connect as the table
-- owner, which row level security does not apply to, and the web app uses
-- Supabase for sign-in only, so nothing that works through the API changes.
--
-- The loop takes every table this role owns in public, including
-- schema_migrations (created by the runner, not by a migration), and skips
-- tables owned by others (an extension's, for example). A table created by a
-- later migration is not covered: it must enable row level security itself.
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and pg_get_userbyid(c.relowner) = current_user
    order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end $$;
