import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { getConfig } from "@opportunity-os/config";
import type { Database } from "./schema";

let instance: Kysely<Database> | undefined;

/** Process-wide Kysely instance backed by a pg Pool (§5 db package, §31 ADR-005). */
export function getDb(): Kysely<Database> {
  if (!instance) {
    const pool = new pg.Pool({ connectionString: getConfig().db.url });
    instance = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = undefined;
  }
}

export type { Database };
