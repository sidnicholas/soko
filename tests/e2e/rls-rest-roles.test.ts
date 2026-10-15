import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { closeDb, createMission, getDb, type Database } from "@opportunity-os/db";
import type { DemandSpecification } from "@opportunity-os/contracts";

/**
 * Supabase's REST API runs as the `authenticated` role (or `anon`), with the
 * caller's id in `request.jwt.claim.sub`. The rest of the suite connects as a
 * superuser, which row level security never applies to, so it proves nothing
 * about that path. These tests switch to the REST role inside a transaction
 * and check what it can actually do (PRD v2 P0: "unauthorized REST write
 * blocked").
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

const SPEC = {
  what: { description: "Need a 27-inch 4K monitor under $220." },
  budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
  quality: { constraints: [] },
  timing: { urgency: "days" },
  payment: { acceptableMethods: ["card"] },
  fulfillment: { type: "ship" },
  flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
  negotiationAuthorization: { mayPrepare: true, maySend: false },
} as unknown as DemandSpecification;

/** Rolled back by throwing this after the checks, so nothing the role does persists. */
class Rollback extends Error {}

/** Runs `fn` as Supabase's `authenticated` role for `userId`, then rolls back. */
async function asRestUser(userId: string, fn: (tx: Kysely<Database>) => Promise<void>): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      await sql`set local role authenticated`.execute(tx);
      await sql`select set_config('request.jwt.claim.sub', ${userId}, true)`.execute(tx);
      await fn(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

/** Postgres error from a statement, or null when it succeeded. */
async function failure(run: () => Promise<unknown>, tx: Kysely<Database>): Promise<string | null> {
  await sql`savepoint probe`.execute(tx);
  try {
    await run();
    await sql`release savepoint probe`.execute(tx);
    return null;
  } catch (err) {
    await sql`rollback to savepoint probe`.execute(tx);
    return String(err);
  }
}

describe.skipIf(!HAS_DB)("row level security under Supabase's REST role (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("lets an owner read their mission over REST but write nothing", async () => {
    // Supabase creates this role and grants it every table in public; mirror that locally.
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$`.execute(getDb());
    await sql`grant usage on schema public, auth to authenticated`.execute(getDb());
    await sql`grant select, insert, update, delete on all tables in schema public to authenticated`.execute(getDb());
    await sql`grant execute on function auth.uid() to authenticated`.execute(getDb());

    const owner = await getDb()
      .insertInto("users")
      .values({ email: `rest-${RUN}@t.test`, display_name: "rest", role: "user" })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const { missionId } = await createMission({
      ownerUserId: owner.id,
      title: "Monitor",
      rawIntent: "Need a monitor",
      autonomyPolicy: "discover_only",
      demandSpec: SPEC,
      changedBy: owner.id,
    });

    await asRestUser(owner.id, async (tx) => {
      // Reads of one's own mission stay allowed (0002 select policies).
      const mine = await tx.selectFrom("missions").select("id").where("id", "=", missionId).execute();
      expect(mine).toHaveLength(1);

      // Inserts are refused outright (0024 dropped the insert policies).
      const insertMission = await failure(
        () =>
          tx
            .insertInto("missions")
            .values({ owner_user_id: owner.id, title: "via REST", raw_intent: "x", status: "draft", current_version_id: null, agent_autonomy_policy: "discover_only", archived_at: null })
            .execute(),
        tx,
      );
      expect(insertMission).toMatch(/row-level security/);
      const insertVersion = await failure(
        () =>
          tx
            .insertInto("mission_versions")
            .values({ mission_id: missionId, version_number: 99, demand_spec_json: JSON.stringify(SPEC), changed_by: owner.id, change_reason: "via REST" })
            .execute(),
        tx,
      );
      expect(insertVersion).toMatch(/row-level security/);

      // An update with no policy matches no rows rather than erroring.
      const updated = await tx.updateTable("missions").set({ title: "renamed via REST" }).where("id", "=", missionId).executeTakeFirst();
      expect(Number(updated.numUpdatedRows)).toBe(0);

      // A table with row level security and no policy shows nothing at all.
      expect(await tx.selectFrom("users").select("id").where("id", "=", owner.id).execute()).toEqual([]);
    });

    const after = await getDb().selectFrom("missions").select("title").where("id", "=", missionId).executeTakeFirstOrThrow();
    expect(after.title).toBe("Monitor");
  });
});
