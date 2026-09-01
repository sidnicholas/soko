import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getConfig } from "@opportunity-os/config";

/**
 * Minimal, dependency-free SQL migration runner. Applies every
 * packages/db/migrations/*.sql in lexicographic order exactly once, tracked in
 * a schema_migrations table, each file in its own transaction. Idempotent: a
 * second run is a no-op. Invoked via `pnpm db:migrate`.
 */
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: getConfig().db.url });
  const client = await pool.connect();
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const appliedRows = await client.query<{ name: string }>("select name from schema_migrations");
    const applied = new Set(appliedRows.rows.map((r) => r.name));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip     ${file}`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        ran++;
        console.log(`applied  ${file}`);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${String(err)}`);
      }
    }
    console.log(`migrations complete: ${ran} applied, ${files.length - ran} already present`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
