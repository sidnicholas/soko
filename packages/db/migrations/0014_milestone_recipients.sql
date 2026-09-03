-- ST-12: multi-party splits. Recipients live on the milestone (rails already
-- advertise supportsMultiRecipient); empty array preserves today's single
-- implicit-recipient behavior exactly.
alter table settlement_milestones add column if not exists recipients_json jsonb not null default '[]';
