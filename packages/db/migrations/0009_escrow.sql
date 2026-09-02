-- Escrow condition/release engine: turn the evidence table into an append-only,
-- hash-chained ledger (§21) carrying the verifier, trust tier, and the predicate
-- each row attests. Chained per (entity_type, entity_id) so a milestone's
-- evidence history is tamper-evident.
alter table evidence add column if not exists verifier text;
alter table evidence add column if not exists trust_tier text;
alter table evidence add column if not exists predicate_type text;
alter table evidence add column if not exists satisfies_json jsonb not null default '{}';
alter table evidence add column if not exists previous_evidence_hash text;
alter table evidence add column if not exists evidence_hash text;

create index if not exists evidence_entity_idx on evidence (entity_type, entity_id, captured_at);
