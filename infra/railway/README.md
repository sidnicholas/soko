# Railway deployment

Railway-first, AWS-portable (ADR-013). Business logic ships as OCI containers and
must not depend on Railway-specific APIs.

1. Create a project and link this repo.
2. Add plugins: PostgreSQL (or point at Supabase), Redis.
3. Point Temporal at Temporal Cloud or a self-hosted namespace.
4. Set env vars from `.env.example`.
5. Deploy services defined in `railway.toml`.
