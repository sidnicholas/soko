import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DemandSpecification } from "@opportunity-os/contracts";
import { createMission, getDb, closeDb } from "@opportunity-os/db";
import { parseDemand } from "@opportunity-os/demand";

/**
 * §3.1(3)/§7 — a natural-language mission with no supplied demand_spec is
 * structured by the parser and persisted as a valid spec on its v0 version
 * (mirrors MissionService.create's parse-when-absent path). Skips without
 * DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();
const INTENT = "Need a 27-inch 4K monitor under $220, delivered this week.";

describe.skipIf(!HAS_DB)("mission from natural language (live postgres)", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await getDb()
      .insertInto("users")
      .values({ email: `nl-${RUN}@example.test`, display_name: "NL Operator", role: "operator" })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    userId = user.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("structures raw intent into a persisted demand_spec", async () => {
    const { spec, source } = await parseDemand({ text: INTENT });
    expect(source).toBe("heuristic"); // echo provider in dev/CI

    const { missionId } = await createMission({
      ownerUserId: userId,
      title: "monitor hunt",
      rawIntent: INTENT,
      autonomyPolicy: "discover_only",
      demandSpec: spec,
      changedBy: userId,
    });

    const row = await getDb()
      .selectFrom("missions as m")
      .innerJoin("mission_versions as v", "v.id", "m.current_version_id")
      .where("m.id", "=", missionId)
      .select(["v.demand_spec_json as spec"])
      .executeTakeFirstOrThrow();
    const persisted = row.spec as DemandSpecification;

    expect(persisted.what.description).toContain("monitor");
    expect(persisted.budget.maximum).toEqual({ amount: 22000, currency: "USD" });
    expect(persisted.timing.urgency).toBe("days");
    expect(persisted.quality.constraints).toContainEqual({ field: "category", operator: "eq", value: "electronics", hard: false });
  });
});
