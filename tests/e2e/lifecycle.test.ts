import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import type { DemandSpecification } from "@opportunity-os/contracts";
import {
  createMission,
  getDb,
  closeDb,
  getOpportunity,
  listOpportunitiesByMission,
  expireStaleOpportunities,
  expireOverdueDemands,
  markStaleSupplyUnavailable,
} from "@opportunity-os/db";
import { refreshCycle } from "../../apps/worker-lifecycle/src/refresh";

/**
 * §3.1(9)/§11.1(10) lifecycle worker against live Postgres: autonomy (a mission
 * yields opportunities via the sweep, no manual trigger) plus the three
 * availability transitions (opportunity/demand expiry, supply retirement).
 * Skips without DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();

describe.skipIf(!HAS_DB)("lifecycle refresh (live postgres)", () => {
  let missionId: string;
  let opportunityId: string;

  beforeAll(async () => {
    const user = await getDb()
      .insertInto("users")
      .values({ email: `lifecycle-${RUN}@example.test`, display_name: "Lifecycle Operator", role: "operator" })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const spec: DemandSpecification = {
      what: { description: "Need a 27-inch 4K monitor under $220, delivered this week." },
      budget: { maximum: { amount: 22000, currency: "USD" }, flexible: true },
      quality: { constraints: [{ field: "category", operator: "eq", value: "electronics", hard: true }] },
      timing: { urgency: "days" },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: true, maySend: false },
    };
    const created = await createMission({
      ownerUserId: user.id,
      title: "4K monitor",
      rawIntent: spec.what.description,
      autonomyPolicy: "discover_only",
      demandSpec: spec,
      changedBy: user.id,
    });
    missionId = created.missionId;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("re-drives discovery for active missions so opportunities appear automatically", async () => {
    const summary = await refreshCycle(1440);
    expect(summary.missionsSwept).toBeGreaterThanOrEqual(1);
    expect(summary.opportunitiesPersisted).toBeGreaterThanOrEqual(1);

    const mine = await listOpportunitiesByMission(missionId);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine[0]!.status).toBe("qualified");
    opportunityId = mine[0]!.id;
  });

  it("expires an overdue opportunity (and does not resurrect it without re-discovery)", async () => {
    await getDb()
      .updateTable("opportunities")
      .set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .where("id", "=", opportunityId)
      .execute();

    const n = await expireStaleOpportunities(new Date().toISOString());
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getOpportunity(opportunityId))!.status).toBe("expired");
  });

  it("expires overdue demands and emits demand.expired.v1 once", async () => {
    const ref = `lc-demand-${RUN}`;
    const inserted = await sql<{ id: string }>`
      insert into demands (source_id, external_ref, description, needed_by, availability_status)
      values ('lifecycle-test', ${ref}, 'overdue demand', ${new Date(Date.now() - 86_400_000).toISOString()}, 'active')
      returning id
    `.execute(getDb());
    const demandId = inserted.rows[0]!.id;

    const n = await expireOverdueDemands(new Date().toISOString());
    expect(n).toBeGreaterThanOrEqual(1);

    const row = await getDb().selectFrom("demands").select(["availability_status"]).where("id", "=", demandId).executeTakeFirstOrThrow();
    expect(row.availability_status).toBe("expired");

    const events = await getDb()
      .selectFrom("outbox")
      .select(["id"])
      .where("event_name", "=", "demand.expired.v1")
      .where("aggregate_id", "=", demandId)
      .execute();
    expect(events).toHaveLength(1);
  });

  it("retires supply not re-observed since the cutoff, leaving fresh supply available", async () => {
    const ref = `lc-defunct-${RUN}`;
    const inserted = await sql<{ id: string }>`
      insert into supply (source_id, external_ref, title, description, availability_status, last_verified_at)
      values ('lifecycle-defunct', ${ref}, 'defunct listing', 'no longer sold', 'available', '2000-01-01T00:00:00.000Z')
      returning id
    `.execute(getDb());
    const supplyId = inserted.rows[0]!.id;

    // Cutoff one hour ago: the defunct row (verified in 2000) is stale; the
    // fixture supply re-observed during discovery (verified ~now) is not.
    const n = await markStaleSupplyUnavailable(new Date(Date.now() - 3_600_000).toISOString());
    expect(n).toBeGreaterThanOrEqual(1);

    const defunct = await getDb().selectFrom("supply").select(["availability_status"]).where("id", "=", supplyId).executeTakeFirstOrThrow();
    expect(defunct.availability_status).toBe("unavailable");

    const fresh = await getDb()
      .selectFrom("supply")
      .select(["availability_status"])
      .where("source_id", "=", "fixture-supply")
      .execute();
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.availability_status === "available")).toBe(true);

    const events = await getDb()
      .selectFrom("outbox")
      .select(["id"])
      .where("event_name", "=", "supply.unavailable.v1")
      .where("aggregate_id", "=", supplyId)
      .execute();
    expect(events).toHaveLength(1);
  });
});
