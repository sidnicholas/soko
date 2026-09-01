import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DemandSpecification } from "@opportunity-os/contracts";
import {
  createMission,
  createNegotiationDraft,
  getNegotiationContext,
  listOpportunitiesByMission,
  getDb,
  closeDb,
} from "@opportunity-os/db";
import { draftNegotiation } from "@opportunity-os/negotiation";
import { runDiscoveryCycle } from "@opportunity-os/discovery";
import { readMoney } from "../../apps/api/src/common/money";

/**
 * §11.2(4)/§13.5 — prepare (never send) a grounded negotiation draft for a
 * discovered opportunity and persist it. Skips without DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();

describe.skipIf(!HAS_DB)("negotiation drafting (live postgres)", () => {
  let opportunityId: string;

  beforeAll(async () => {
    const user = await getDb()
      .insertInto("users")
      .values({ email: `neg-${RUN}@t.test`, display_name: "Op", role: "operator" })
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
    const mission = await createMission({
      ownerUserId: user.id, title: "monitor", rawIntent: spec.what.description,
      autonomyPolicy: "discover_only", demandSpec: spec, changedBy: user.id,
    });
    await runDiscoveryCycle({
      missionId: mission.missionId, query: "",
      demand: { description: spec.what.description, category: "electronics", targetPriceMinor: null, maxBudgetMinor: 22000, currency: "USD", urgencyScore: 0.6 },
    });
    opportunityId = (await listOpportunitiesByMission(mission.missionId))[0]!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("grounds and persists a non-binding draft with approved bounds", async () => {
    const ctx = await getNegotiationContext(opportunityId);
    expect(ctx).toBeDefined();
    expect(ctx!.supplyTitle.toLowerCase()).toContain("monitor");

    const supply = readMoney(ctx!.supplyPrice);
    const budget = readMoney(ctx!.demandMaxBudget) ?? readMoney(ctx!.demandTargetPrice);
    const draft = await draftNegotiation({
      side: "buy",
      itemTitle: ctx!.supplyTitle,
      itemDescription: ctx!.supplyDescription,
      targetPriceMinor: supply?.amountMinor ?? null,
      maxAmountMinor: budget?.amountMinor ?? null,
      currency: supply?.currency ?? ctx!.supplyCurrency ?? "USD",
    });
    expect(draft.messages.length).toBeGreaterThan(0);
    expect(draft.approvedBounds.maxAmountMinor).toBe(22000);

    const negotiation = await createNegotiationDraft({
      opportunityId,
      side: "buy",
      messages: draft.messages,
      approvedBounds: draft.approvedBounds,
    });

    const row = await getDb().selectFrom("negotiations").selectAll().where("id", "=", negotiation.id).executeTakeFirstOrThrow();
    expect(row.side).toBe("buy");
    expect(row.state).toBe("draft");
    expect(Array.isArray(row.draft_messages_json) && row.draft_messages_json.length > 0).toBe(true);
    expect(row.approved_bounds_json).toMatchObject({ currency: "USD", maxAmountMinor: 22000 });

    const events = await getDb()
      .selectFrom("outbox")
      .select(["id"])
      .where("event_name", "=", "negotiation.draft_ready.v1")
      .where("aggregate_id", "=", negotiation.id)
      .execute();
    expect(events).toHaveLength(1);
  });
});
