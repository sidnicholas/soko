import { describe, it, expect, afterAll } from "vitest";
import {
  closeDb,
  createSignal,
  getDb,
  getEntityIdForMember,
  getOpportunityDetails,
  resolveSignal,
  upsertMatch,
  upsertOpportunity,
  upsertSourceDemand,
  upsertSupply,
} from "@opportunity-os/db";
import { buildGraphEdges, opportunitiesFromGraph, resolveEntities } from "@opportunity-os/discovery";

/**
 * The buyer and seller behind an opportunity: for a demand/supply match, the
 * demand, the supply listing (URL, seller, location, condition) and the match
 * explanation; for a graph deal, the listings grouped into its entities. A
 * later sighting without a detail keeps what was stored. Skips without
 * DATABASE_URL.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();

describe.skipIf(!HAS_DB)("opportunity details (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("returns both sides of a match with the listing's seller, link and location", async () => {
    const { demandId } = await upsertSourceDemand({
      sourceId: "sms",
      externalRef: `od-demand-${RUN}`,
      description: "Need a 27 inch 4K monitor for a home office",
      category: "electronics",
      targetPriceMinor: 25000,
      currency: "USD",
    });
    const supplyInput = {
      sourceId: "ebay",
      externalRef: `od-supply-${RUN}`,
      title: "27in 4K Monitor",
      description: "Refurbished, 12mo warranty",
      category: "electronics",
      priceMinor: 18900,
      currency: "USD",
      quantity: 1,
      sourceReliability: 0.8,
    };
    const { supplyId } = await upsertSupply({
      ...supplyInput,
      listingUrl: `https://www.ebay.com/itm/${RUN}`,
      seller: { name: "monitor_outlet", url: "https://www.ebay.com/usr/monitor_outlet", detail: "99.6% positive" },
      location: { label: "Austin, TX, US", city: "Austin", region: "TX", country: "US" },
      condition: "Seller refurbished",
    });
    // A later sighting that carries no details must not wipe them.
    await upsertSupply(supplyInput);

    const { matchId } = await upsertMatch({
      demandId,
      supplyId,
      semantic: 0.7,
      constraint: 1,
      geography: 0.5,
      timing: 0.8,
      quality: 0.9,
      total: 0.78,
      explanation: { categoryAligned: true, withinBudget: true, sharedTerms: ["4k", "monitor"], rationale: "Same category, under the target price." },
    });
    const { opportunityId } = await upsertOpportunity({
      matchId,
      status: "qualified",
      transactionRole: "broker",
      expectedRevenueMinor: 25000,
      expectedDirectCostMinor: 18900,
      expectedNetProfitMinor: 6100,
      capitalRequiredMinor: 18900,
      currency: "USD",
      closeProbability: 0.5,
      timeToCashMinutes: 120,
      repeatabilityScore: 0.3,
      paymentCertaintyScore: 0.7,
      fraudRiskScore: 0.1,
      complianceRiskScore: 0,
      operationalFrictionScore: 0.3,
      customerValueScore: 0.6,
      overallScore: 0.6,
      scoreVersion: "test",
      nextAction: null,
    });

    const details = (await getOpportunityDetails(opportunityId))!;
    expect(details.match).toMatchObject({ shared_terms: ["4k", "monitor"], category_aligned: true, within_budget: true, rationale: "Same category, under the target price." });
    expect(details.match!.scores.total).toBeCloseTo(0.78, 5);

    const buyer = details.sides.find((s) => s.role === "buyer")!.parties[0]!;
    expect(buyer).toMatchObject({ kind: "demand", id: demandId, platform: "sms", price: { amount: 25000, currency: "USD" }, price_label: "Target price", url: null, mission: null });

    const seller = details.sides.find((s) => s.role === "seller")!.parties[0]!;
    expect(seller).toMatchObject({
      kind: "supply",
      id: supplyId,
      title: "27in 4K Monitor",
      platform: "ebay",
      url: `https://www.ebay.com/itm/${RUN}`,
      counterparty: { name: "monitor_outlet", url: "https://www.ebay.com/usr/monitor_outlet", detail: "99.6% positive" },
      location: "Austin, TX, US",
      condition: "Seller refurbished",
      price: { amount: 18900, currency: "USD" },
      price_label: "Asking price",
    });
    expect(seller.last_verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await getOpportunityDetails("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("lists the listings behind a graph arbitrage deal on each side", async () => {
    async function supply(ref: string, desc: string, priceMinor: number): Promise<string> {
      const sig = await createSignal({
        channel: "merchant_feed", kind: "supply", sourceId: `od-${ref}`, externalRef: `od-${ref}`,
        title: desc, description: desc, category: "electronics", priceMinor, currency: "USD",
        contentHash: `od-${ref}-${priceMinor}`, sourceReliability: 0.6,
      });
      return (await resolveSignal(sig.signalId))!.entityId;
    }
    const cheap = await supply(`a-${RUN}`, "bose quietcomfort 45 wireless noise cancelling headphones", 12000);
    const dear = await supply(`b-${RUN}`, "bose quietcomfort ultra wireless noise cancelling headphones", 22000);

    await resolveEntities();
    await buildGraphEdges();
    await opportunitiesFromGraph();
    const src = (await getEntityIdForMember("supply", cheap))!;
    const dst = (await getEntityIdForMember("supply", dear))!;
    const arb = await getDb().selectFrom("opportunities").select("id").where("dedupe_key", "=", `arb:${src}:${dst}`).executeTakeFirstOrThrow();

    const details = (await getOpportunityDetails(arb.id))!;
    expect(details.kind).toBe("arbitrage");
    expect(details.match).toBeNull();
    expect(details.sides.find((s) => s.label === "Buy from")!.parties.map((p) => p.id)).toContain(cheap);
    expect(details.sides.find((s) => s.label === "Sell into")!.parties.map((p) => p.id)).toContain(dear);
    expect(details.sides.find((s) => s.label === "Buy from")!.parties[0]!.signal).toMatchObject({ channel: "merchant_feed" });
  });
});
