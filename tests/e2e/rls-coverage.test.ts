import { describe, it, expect, afterAll } from "vitest";
import { sql } from "kysely";
import { closeDb, getDb } from "@opportunity-os/db";

/**
 * Every table in the public schema has row level security on. Supabase serves
 * that schema through its REST API to anyone holding the anon key, so a table
 * without it can be read and written around the API. A migration that adds a
 * table must enable it there (migration 0022 covers only the tables that
 * existed when it ran).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("row level security coverage (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("is enabled on every public table", async () => {
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean }>`
      select c.relname, c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `.execute(getDb());
    expect(rows.length).toBeGreaterThan(25);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });
});
