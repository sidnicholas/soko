import pg from "pg";
import { getConfig } from "@opportunity-os/config";

/**
 * Opt-in pgvector bootstrap (ADR-026). Enables the extension, adds an
 * `embedding_vec vector(dim)` column + hnsw cosine index to entities, and
 * backfills it from the jsonb `embedding`. Safe to run anywhere: if pgvector
 * is unavailable (plain Postgres/CI) it logs and skips. Run: `pnpm db:pgvector`
 * on Supabase / the pgvector-image CI job. Idempotent.
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const dim = cfg.llm.embeddingDim;
  const pool = new pg.Pool({ connectionString: cfg.db.url });
  const client = await pool.connect();
  try {
    try {
      await client.query("create extension if not exists vector");
    } catch (err) {
      console.log(`pgvector unavailable, skipping bootstrap: ${String(err)}`);
      return;
    }
    await client.query(`alter table entities add column if not exists embedding_vec vector(${dim})`);
    await client.query(
      "create index if not exists entities_embedding_hnsw on entities using hnsw (embedding_vec vector_cosine_ops)",
    );
    const res = await client.query(
      "update entities set embedding_vec = (embedding::text)::vector where embedding is not null and embedding_vec is null",
    );
    console.log(`pgvector ready (dim ${dim}); backfilled ${res.rowCount ?? 0} rows`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
