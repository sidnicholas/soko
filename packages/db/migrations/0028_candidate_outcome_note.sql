-- A free-text summary of why an operator closed out a candidate (dismissed,
-- lost, won), beside the reason code. The note is what the reason code cannot
-- say; both feed the learning loop (PRD v2 FR-14: retain negative outcomes and
-- reasons). Nullable: older rows and status changes without a note keep null.
alter table intel_candidates add column if not exists outcome_note text;
