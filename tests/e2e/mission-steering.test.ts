import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDb,
  closeDb,
  createMission,
  upsertMissionDemand,
  upsertSupply,
  upsertMatch,
  upsertOpportunity,
  getOpportunity,
  rejectOpportunity,
  steerMission,
  listRejectedOpportunities,
  getOpportunityMissionId,
  getMission,
  missionTimeline,
  type UpsertOpportunityInput,
} from "@opportunity-os/db";
import { excludedTerms, type DemandSpecification } from "@opportunity-os/contracts";
import { projectMissionDemand } from "@opportunity-os/discovery";

/**
 * Phase 4 user→agent steering: rejection with a reason, exclusions recorded as
 * a new constraints version that discovery projects, matching open
 * opportunities set aside immediately — and re-discovery never resurrecting a
 * rejected (or otherwise acted-on) opportunity.
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

function opportunityInput(matchId: string): UpsertOpportunityInput {
  return {
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
  };
}

describe.skipIf(!HAS_DB)("mission steering (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("rejects with a reason, steers exclusions into a new version, and never resurrects on re-discovery", async () => {
    const owner = await getDb()
      .insertInto("users")
      .values({ email: `steer-${RUN}@t.test`, display_name: "Owner", role: "user" })
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
    const { demandId } = await upsertMissionDemand({
      missionId,
      sourceId: "mission",
      description: "27-inch 4K monitor",
      category: null,
      targetPriceMinor: null,
      maxBudgetMinor: 22000,
      currency: "USD",
      urgencyScore: 0.6,
    });

    async function opportunity(title: string) {
      const { supplyId } = await upsertSupply({
        sourceId: "fixture",
        externalRef: `steer-${RUN}-${title}`,
        title,
        description: `${title} in good condition`,
        category: "electronics",
        priceMinor: 15000,
        currency: "USD",
        quantity: 1,
        sourceReliability: 0.8,
      });
      const { matchId } = await upsertMatch({
        demandId,
        supplyId,
        semantic: 0.8,
        constraint: 0.8,
        geography: 1,
        timing: 1,
        quality: 0.8,
        total: 0.8,
        explanation: {},
      });
      const { opportunityId } = await upsertOpportunity(opportunityInput(matchId));
      return { matchId, opportunityId };
    }

    const dell = await opportunity(`Dell U2723QE ${RUN}`);
    const refurb = await opportunity(`Refurbished LG 27UK850 ${RUN}`);
    const benq = await opportunity(`BenQ PD2705U ${RUN}`);
    expect(await getOpportunityMissionId(dell.opportunityId)).toBe(missionId);

    // A user rejection carries its reason and survives re-scoring.
    expect(await rejectOpportunity({ opportunityId: dell.opportunityId, reason: "Seller has bad reviews", actorId: owner.id })).toBe(true);
    expect(await rejectOpportunity({ opportunityId: dell.opportunityId, reason: "again", actorId: owner.id })).toBe(false);
    await upsertOpportunity(opportunityInput(dell.matchId));
    const dellRow = (await getOpportunity(dell.opportunityId))!;
    expect(dellRow.status).toBe("rejected");
    expect(dellRow.rejection_reason).toBe("Seller has bad reviews");

    // Re-discovery also must not reset an opportunity a human moved forward.
    await getDb().updateTable("opportunities").set({ status: "approved" }).where("id", "=", benq.opportunityId).execute();
    await upsertOpportunity(opportunityInput(benq.matchId));
    expect((await getOpportunity(benq.opportunityId))!.status).toBe("approved");

    // Steering: exclusion becomes a versioned constraint and sets matching open opportunities aside.
    const result = await steerMission({ missionId, excludeTerms: ["refurbished", " Refurbished "], note: "New only", actorId: owner.id });
    expect(result.addedTerms).toEqual(["refurbished"]);
    expect(result.rejectedOpportunityIds).toEqual([refurb.opportunityId]);
    expect((await getOpportunity(refurb.opportunityId))!.rejection_reason).toBe('Excluded by steering: "refurbished"');

    const mission = (await getMission(missionId))!;
    const version = await getDb()
      .selectFrom("mission_versions")
      .selectAll()
      .where("id", "=", mission.current_version_id!)
      .executeTakeFirstOrThrow();
    expect(version.version_number).toBe(1);
    expect(version.change_reason).toBe('steer: exclude "refurbished" — New only');
    const spec = version.demand_spec_json as DemandSpecification;
    expect(excludedTerms(spec)).toEqual(["refurbished"]);
    expect(projectMissionDemand(spec).excludeTerms).toEqual(["refurbished"]);

    // Repeating the same exclusion adds nothing.
    expect((await steerMission({ missionId, excludeTerms: ["REFURBISHED"], note: null, actorId: owner.id })).addedTerms).toEqual([]);

    const rejected = await listRejectedOpportunities(missionId);
    expect(rejected.map((r) => r.id).sort()).toEqual([dell.opportunityId, refurb.opportunityId].sort());

    const timeline = (await missionTimeline(missionId))!;
    expect(timeline.some((e) => e.action === "mission.steered" && e.summary?.includes("1 opportunity set aside"))).toBe(true);
    expect(timeline.find((e) => e.action === "opportunity.rejected" && e.entity_id === dell.opportunityId)?.summary).toBe("Seller has bad reviews");
  });
});
