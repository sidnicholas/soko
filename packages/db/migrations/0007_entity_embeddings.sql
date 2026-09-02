-- Entity embeddings for similarity (substitutes/comparables). Stored as jsonb
-- float array so this runs on plain Postgres/CI; pgvector (vector column + ANN
-- index) is the Supabase-prod drop-in upgrade — see ADR-024.
alter table entities add column embedding jsonb;
