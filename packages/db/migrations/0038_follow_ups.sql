-- Follow-ups for candidates being worked (ADR-047).
--
-- A candidate marked contacted or responded leaves the Action Queue and is
-- worked from Follow-ups, where it ages: each touch (first contact,
-- follow-up, response) is logged, the next follow-up is due on a cadence,
-- and one that got no answer goes cold for the operator to close. Won, lost
-- and dismissed candidates are the closed archive.

-- When user_status last changed, kept by a trigger so every writer (the
-- queue, Pipedrive sync, outreach) ages it the same way. updated_at is not
-- usable: each intel run re-scores candidates and bumps it.
alter table intel_candidates add column if not exists status_changed_at timestamptz;
-- "Remind me on": hides the follow-up until then; cleared by a status change.
alter table intel_candidates add column if not exists snoozed_until timestamptz;

update intel_candidates set status_changed_at = updated_at where status_changed_at is null and user_status <> 'open';

create or replace function intel_candidates_status_changed() returns trigger language plpgsql as $$
begin
  if new.user_status is distinct from old.user_status then
    new.status_changed_at := now();
    new.snoozed_until := null;
  end if;
  return new;
end;
$$;
drop trigger if exists intel_candidates_status_changed on intel_candidates;
create trigger intel_candidates_status_changed before update of user_status on intel_candidates
  for each row execute function intel_candidates_status_changed();

create table if not exists candidate_touches (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references intel_candidates(id) on delete cascade,
  kind          text not null check (kind in ('contacted', 'follow_up', 'responded', 'note')),
  channel       text check (channel in ('email', 'phone', 'text', 'platform_message', 'in_person', 'other')),
  note          text,
  -- manual: logged by a person; outreach: an approved email was sent or a reply filed.
  source        text not null default 'manual' check (source in ('manual', 'outreach', 'crm')),
  -- The conversation message behind an outreach touch, so it is logged once.
  ref_id        uuid unique,
  occurred_at   timestamptz not null default now(),
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists candidate_touches_candidate_idx on candidate_touches(candidate_id, occurred_at desc);
alter table candidate_touches enable row level security;

-- Candidates already being worked start their cadence from their last status change.
insert into candidate_touches (candidate_id, kind, occurred_at)
select c.id, case when c.user_status = 'responded' then 'responded' else 'contacted' end, c.status_changed_at
from intel_candidates c
where c.user_status in ('contacted', 'responded')
  and not exists (select 1 from candidate_touches t where t.candidate_id = c.id);
