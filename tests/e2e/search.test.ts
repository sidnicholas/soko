import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDb,
  closeDb,
  createMission,
  shareMission,
  upsertMissionDemand,
  upsertSupply,
  upsertMatch,
  upsertOpportunity,
  rejectOpportunity,
  searchForUser,
} from "@opportunity-os/db";
import type { DemandSpecification } from "@opportunity-os/contracts";

/**
 * Phase 4 Search — results follow the same visibility as mission access:
 * owned + shared for a regular user, everything for staff; rejected
 * opportunities stay out; LIKE wildcards in the query are literal.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const TOKEN = `zq${RUN}`; // unique so other test data can't match

const SPEC = {
  what: { description: "monitor" },
  budget: { flexible: true },
  quality: { constraints: [] },
  timing: { urgency: "days" },
  payment: { acceptableMethods: ["card"] },
  fulfillment: { type: "ship" },
  flexibility: { substitutesAllowed: true, negotiableFields: [], nonNegotiables: [] },
  negotiationAuthorization: { mayPrepare: false, maySend: false },
} as unknown as DemandSpecification;

describe.skipIf(!HAS_DB)("search (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("scopes missions and opportunities to what the caller can see", async () => {
    const mkUser = async (tag: string) =>
      (
        await getDb()
          .insertInto("users")
          .values({ email: `search-${tag}-${RUN}@t.test`, display_name: tag, role: "user" })
          .returning(["id", "email"])
          .executeTakeFirstOrThrow()
      );
    const owner = await mkUser("owner");
    const guest = await mkUser("guest");
    const { missionId } = await createMission({
      ownerUserId: owner.id,
      title: `Monitor ${TOKEN}`,
      rawIntent: "Need a monitor",
      autonomyPolicy: "discover_only",
      demandSpec: SPEC,
      changedBy: owner.id,
    });
    const { demandId } = await upsertMissionDemand({
      missionId,
      sourceId: "mission",
      description: "monitor",
      category: null,
      targetPriceMinor: null,
      maxBudgetMinor: 22000,
      currency: "USD",
      urgencyScore: 0.5,
    });
    const opp = async (title: string) => {
      const { supplyId } = await upsertSupply({
        sourceId: "fixture",
        externalRef: `search-${RUN}-${title}`,
        title,
        description: "listing",
        category: "electronics",
        priceMinor: 15000,
        currency: "USD",
        quantity: 1,
        sourceReliability: 0.8,
      });
      const { matchId } = await upsertMatch({ demandId, supplyId, semantic: 0.8, constraint: 0.8, geography: 1, timing: 1, quality: 0.8, total: 0.8, explanation: {} });
      return (
        await upsertOpportunity({
          matchId,
          status: "qualified",
          transactionRole: "broker",
          expectedRevenueMinor: 22000,
          expectedDirectCostMinor: 15000,
          expectedNetProfitMinor: 7000,
          capitalRequiredMinor: 0,
          currency: "USD",
          closeProbability: 0.7,
          timeToCashMinutes: 60,
          repeatabilityScore: 0.4,
          paymentCertaintyScore: 0.8,
          fraudRiskScore: 0,
          complianceRiskScore: 0,
          operationalFrictionScore: 0.3,
          customerValueScore: 0.7,
          overallScore: 0.7,
          scoreVersion: "v1",
          nextAction: "operator_review",
        })
      ).opportunityId;
    };
    const live = await opp(`Dell ${TOKEN} 27in`);
    const setAside = await opp(`LG ${TOKEN} 27in`);
    await rejectOpportunity({ opportunityId: setAside, reason: "no", actorId: owner.id });

    const ownerHits = await searchForUser({ userId: owner.id, query: TOKEN.toUpperCase(), allMissions: false });
    expect(ownerHits.missions.map((m) => m.id)).toEqual([missionId]);
    expect(ownerHits.opportunities.map((o) => o.id)).toEqual([live]);
    expect(ownerHits.opportunities[0]!.mission_title).toBe(`Monitor ${TOKEN}`);

    const before = await searchForUser({ userId: guest.id, query: TOKEN, allMissions: false });
    expect(before.missions).toHaveLength(0);
    expect(before.opportunities).toHaveLength(0);

    await shareMission({ missionId, email: guest.email, role: "viewer", grantedBy: owner.id });
    expect((await searchForUser({ userId: guest.id, query: TOKEN, allMissions: false })).missions).toHaveLength(1);

    // Staff read-all, and wildcards are literal (a bare "%" must not match everything).
    expect((await searchForUser({ userId: randomUUID(), query: TOKEN, allMissions: true })).missions).toHaveLength(1);
    expect((await searchForUser({ userId: owner.id, query: `${TOKEN}%`, allMissions: false })).missions).toHaveLength(0);
  }, 30_000); // many sequential round trips to a remote Postgres
});
