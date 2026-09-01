import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DemandSpecification } from "@opportunity-os/contracts";
import {
  createMission,
  listOpportunitiesByMission,
  listOpportunitiesForOperator,
  getDb,
  closeDb,
} from "@opportunity-os/db";
import { runDiscoveryCycle, type DiscoveryInput } from "@opportunity-os/discovery";

/**
 * §11.1 / Phase 1 exit criterion: test-source opportunities automatically enter
 * the database, match, score, refresh (idempotently), and appear on the
 * operator feed — end to end through the real repositories, matching engine,
 * scoring, and transactional outbox against a live Postgres.
 *
 * Skips without DATABASE_URL so the default unit suite stays hermetic; the CI
 * Postgres job (or a local `pnpm db:migrate`'d database) exercises it.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const MONITOR_DEMAND = "Need a 27-inch 4K monitor under $220, delivered this week.";

describe.skipIf(!HAS_DB)("discovery loop (live postgres)", () => {
  let missionId: string;

  beforeAll(async () => {
    const user = await getDb()
      .insertInto("users")
      .values({ email: `smoke-${Date.now()}@example.test`, display_name: "Smoke Operator", role: "operator" })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const spec: DemandSpecification = {
      what: { description: MONITOR_DEMAND },
      budget: { target: { amount: 22000, currency: "USD" }, flexible: false },
      quality: { constraints: [] },
      timing: { urgency: "days" },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: true, maySend: false },
    };
    const created = await createMission({
      ownerUserId: user.id,
      title: "4K monitor",
      rawIntent: MONITOR_DEMAND,
      autonomyPolicy: "discover_only",
      demandSpec: spec,
      changedBy: user.id,
    });
    missionId = created.missionId;
  });

  afterAll(async () => {
    await closeDb();
  });

  const input = (): DiscoveryInput => ({
    missionId,
    query: "",
    demand: {
      description: MONITOR_DEMAND,
      category: "electronics",
      targetPriceMinor: 22000,
      maxBudgetMinor: null,
      currency: "USD",
      urgencyScore: 0.6,
    },
  });

  it("persists supply, matches the in-budget monitor, and surfaces a qualified opportunity", async () => {
    const r = await runDiscoveryCycle(input());
    // Three fixture supply rows persist; only the in-category, in-budget monitor
    // clears MATCH_MIN_TOTAL (chairs are cross-category; USB-C cables blow budget).
    expect(r.supplyPersisted).toBe(3);
    expect(r.matchesPersisted).toBe(1);
    expect(r.opportunitiesPersisted).toBe(1);
    expect(r.topScore).toBeGreaterThan(0);

    const mine = await listOpportunitiesByMission(missionId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("qualified");
    expect(mine[0]!.transaction_role).toBe("broker");
    expect(Number(mine[0]!.overall_score)).toBeGreaterThan(0);

    const feed = await listOpportunitiesForOperator();
    expect(feed.some((o) => o.id === mine[0]!.id)).toBe(true);
  });

  it("is idempotent across refresh cycles (rows refresh in place, no duplicates)", async () => {
    const r = await runDiscoveryCycle(input());
    expect(r.supplyPersisted).toBe(3);
    expect(r.opportunitiesPersisted).toBe(1);
    expect(await listOpportunitiesByMission(missionId)).toHaveLength(1);
  });

  it("emits opportunity.qualified.v1 exactly once via the outbox", async () => {
    const opp = (await listOpportunitiesByMission(missionId))[0]!;
    const rows = await getDb()
      .selectFrom("outbox")
      .select(["id"])
      .where("event_name", "=", "opportunity.qualified.v1")
      .where("aggregate_id", "=", opp.id)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
