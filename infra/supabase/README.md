# Supabase

Initial system of record (ADR-005). Apply SQL migrations from
`packages/db/migrations` (0001_init.sql then 0002_rls.sql). Row Level Security
is enabled for user-facing tables; backend services use the service-role key and
enforce authorization in `packages/auth`.
