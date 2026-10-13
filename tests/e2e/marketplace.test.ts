import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDb,
  closeDb,
  createMission,
  upsertMissionDemand,
  upsertSupply,
  upsertMatch,
  createIntelRun,
  insertIntelLead,
  upsertIntelCandidate,
  listMarketListings,
  listOffNetworkMatches,
  createOffNetworkMatch,
  updateOffNetworkMatchStatus,
  type NewIntelCandidate,
  type NewIntelLead,
} from "@opportunity-os/db";
import type { DemandSpecification } from "@opportunity-os/contracts";

/**
 * Marketplace listing — every demand and supply record appears on its own,
 * from both origins, and `matched` is true only when an opposite side was
 * actually found (a match row, or an intel candidate with a counterparty that
 * was not rejected).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

const SPEC = {
  what: { description: "forklift" },
  budget: { flexible: true },
  quality: { constraints: [] },
  timing: { urgency: "days" },
  payment: { acceptableMethods: ["card"] },
  fulfillment: { type: "ship" },
  flexibility: { substitutesAllowed: true, negotiableFields: [], nonNegotiables: [] },
  negotiationAuthorization: { mayPrepare: false, maySend: false },
} as unknown as DemandSpecification;

describe.skipIf(!HAS_DB)("marketplace listings (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("lists mission demand and connector supply, flagging which have a match", async () => {
    const owner = await getDb()
      .insertInto("users")
      .values({ email: `market-${RUN}@t.test`, display_name: "owner", role: "user" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const demand = async (title: string, budgetMinor: number) => {
      const { missionId } = await createMission({ ownerUserId: owner.id, title, rawIntent: title, autonomyPolicy: "discover_only", demandSpec: SPEC, changedBy: owner.id });
      return (
        await upsertMissionDemand({ missionId, sourceId: "mission", description: `${title} description`, category: "equipment", targetPriceMinor: null, maxBudgetMinor: budgetMinor, currency: "USD", urgencyScore: 0.5 })
      ).demandId;
    };
    const supply = async (title: string) =>
      (await upsertSupply({ sourceId: "fixture", externalRef: `market-${RUN}-${title}`, title, description: "listing", category: "equipment", priceMinor: 650000, currency: "USD", quantity: 3, sourceReliability: 0.8 }))
        .supplyId;

    const pairedDemand = await demand(`Forklift ${RUN}`, 700000);
    const loneDemand = await demand(`Pallet jack ${RUN}`, 40000);
    const pairedSupply = await supply(`Toyota forklift ${RUN}`);
    const loneSupply = await supply(`Reach truck ${RUN}`);
    await upsertMatch({ demandId: pairedDemand, supplyId: pairedSupply, semantic: 0.8, constraint: 0.8, geography: 1, timing: 1, quality: 0.8, total: 0.8, explanation: {} });

    const byId = new Map((await listMarketListings()).map((l) => [l.id, l]));

    const d1 = byId.get(`marketplace:${pairedDemand}`)!;
    expect(d1).toMatchObject({ side: "demand", origin: "marketplace", title: `Forklift ${RUN}`, price_minor: 700000, matched: true });
    expect(d1.match_detail).toBe("1 match, 0 live opportunities");
    expect(byId.get(`marketplace:${loneDemand}`)).toMatchObject({ side: "demand", matched: false, match_detail: "no_match", price_minor: 40000 });

    expect(byId.get(`marketplace:${pairedSupply}`)).toMatchObject({ side: "supply", origin: "marketplace", price_minor: 650000, quantity: "3", matched: true });
    expect(byId.get(`marketplace:${loneSupply}`)).toMatchObject({ side: "supply", matched: false, match_detail: "no_match" });
  });

  it("lists intel leads on their own and counts a pairing only when a counterparty was found", async () => {
    const runId = await createIntelRun();
    const lead = async (kind: NewIntelLead["kind"], slug: string) =>
      (await insertIntelLead({
        runId,
        kind,
        title: `${slug} ${RUN}`,
        summary: `${slug} summary`,
        url: `https://board.example.com/${slug}-${RUN}`,
        urlHash: `market-${RUN}-${slug}`,
        hostname: "board.example.com",
        query: "site:board.example.com test",
        searchProvider: "stub",
        publishedAt: null,
        ageText: null,
        item: slug,
        category: "equipment",
        quantity: "2",
        location: "Dayton OH",
        deadline: "this week",
        priceMinor: 500000,
        currency: "USD",
        urgency: "high",
        credibility: 0.7,
        contact: { channel: "listing", value: null, label: "source_fact" },
        facts: [],
        oppositeQueries: [],
      }))!;
    const candidate = (leadId: string, over: Partial<NewIntelCandidate>): Promise<string> =>
      upsertIntelCandidate({
        runId,
        leadId,
        counterUrl: null,
        counterSummary: null,
        serviceKey: null,
        matchKind: "demand_to_supply",
        title: "candidate",
        matchRationale: "test",
        verificationStatus: "plausible",
        freshness: 0.8,
        economics: {},
        monetization: {},
        regulatoryFlags: [],
        fraudFlags: [],
        contact: null,
        evLowUsd: 0,
        evHighUsd: 0,
        confidence: "low",
        score: 10,
        explanation: {},
        outreach: {},
        bucket: "watch",
        rejectReason: null,
        ...over,
      });

    const unassessed = await lead("demand", "wtb-forklift");
    const noCounterparty = await lead("demand", "wtb-racking");
    await candidate(noCounterparty, { bucket: "watch", rejectReason: "no_counterparty_found" });
    const serviced = await lead("problem", "ga4-broken");
    await candidate(serviced, { matchKind: "problem_to_service", serviceKey: "analytics_tracking", bucket: "verify_next" });
    const rejectedSupply = await lead("supply", "surplus-pallets");
    await candidate(rejectedSupply, { matchKind: "supply_to_demand", counterUrl: "https://buyer.example.com/x", bucket: "rejected", rejectReason: "stale" });

    const byId = new Map((await listMarketListings()).map((l) => [l.id, l]));

    expect(byId.get(`intel:${unassessed}`)).toMatchObject({
      side: "demand",
      origin: "intel",
      type: "demand",
      source: "board.example.com",
      url: `https://board.example.com/wtb-forklift-${RUN}`,
      price_minor: 500000,
      quantity: "2",
      location: "Dayton OH",
      needed_by: "this week",
      matched: false,
      match_detail: "not_assessed",
    });
    expect(byId.get(`intel:${noCounterparty}`)).toMatchObject({ matched: false, match_detail: "no_counterparty_found" });
    // A problem someone needs fixed is demand for a service.
    expect(byId.get(`intel:${serviced}`)).toMatchObject({ side: "demand", type: "problem", matched: true, match_detail: "verify_next" });
    expect(byId.get(`intel:${rejectedSupply}`)).toMatchObject({ side: "supply", type: "supply", matched: false, match_detail: "stale" });
  });

  it("records an off-network counterparty against a listing and tracks the deal", async () => {
    const { supplyId } = await upsertSupply({ sourceId: "fixture", externalRef: `market-${RUN}-offnet`, title: `Pallet racking ${RUN}`, description: "listing", category: "equipment", priceMinor: 90000, currency: "USD", quantity: 1, sourceReliability: 0.8 });
    const runId = await createIntelRun();
    const leadId = (await insertIntelLead({
      runId,
      kind: "demand",
      title: `Needs a reach truck ${RUN}`,
      summary: "Warehouse needs a reach truck",
      url: `https://board.example.com/offnet-${RUN}`,
      urlHash: `market-${RUN}-offnet`,
      hostname: "board.example.com",
      query: "site:board.example.com test",
      searchProvider: "stub",
      publishedAt: null,
      ageText: null,
      item: "reach truck",
      category: "equipment",
      quantity: null,
      location: null,
      deadline: null,
      priceMinor: null,
      currency: null,
      urgency: "medium",
      credibility: 0.6,
      contact: null,
      facts: [],
      oppositeQueries: [],
    }))!;

    // An intel demand lead: the operator brings the supply.
    const forLead = (await createOffNetworkMatch({ origin: "intel", ref: leadId, counterpartyName: "Acme Lift Trucks", counterpartyContact: "sales@acme.example", terms: "2019 reach truck, delivered", priceMinor: 1200000, currency: "USD", createdBy: "op-1" }))!;
    expect(forLead).toMatchObject({ listing_id: `intel:${leadId}`, listing_side: "demand", listing_title: `Needs a reach truck ${RUN}`, counterparty_name: "Acme Lift Trucks", price_minor: 1200000, status: "open", created_by: "op-1" });
    // A marketplace supply row: the operator brings the buyer.
    const forSupply = (await createOffNetworkMatch({ origin: "marketplace", ref: supplyId, counterpartyName: "Dayton Storage Co", counterpartyContact: null, terms: null, priceMinor: null, currency: null, createdBy: "op-1" }))!;
    expect(forSupply).toMatchObject({ listing_id: `marketplace:${supplyId}`, listing_side: "supply", listing_title: `Pallet racking ${RUN}` });
    // No such listing: nothing is recorded.
    expect(await createOffNetworkMatch({ origin: "intel", ref: randomUUID(), counterpartyName: "Nobody", counterpartyContact: null, terms: null, priceMinor: null, currency: null, createdBy: "op-1" })).toBeUndefined();

    const byId = new Map((await listMarketListings()).map((l) => [l.id, l]));
    // The system still found no counterparty itself; the operator's deal rides alongside.
    expect(byId.get(`intel:${leadId}`)).toMatchObject({ matched: false });
    expect(byId.get(`intel:${leadId}`)!.off_network.map((m) => m.id)).toEqual([forLead.id]);
    expect(byId.get(`marketplace:${supplyId}`)!.off_network.map((m) => m.counterparty_name)).toEqual(["Dayton Storage Co"]);

    const agreed = (await updateOffNetworkMatchStatus(forLead.id, { status: "agreed", note: "PO expected Friday" }))!;
    expect(agreed).toMatchObject({ status: "agreed", outcome_note: "PO expected Friday" });
    // A status change without a note keeps the note already recorded.
    expect(await updateOffNetworkMatchStatus(forLead.id, { status: "won" })).toMatchObject({ status: "won", outcome_note: "PO expected Friday" });
    expect(await updateOffNetworkMatchStatus(randomUUID(), { status: "lost" })).toBeUndefined();

    const mine = (await listOffNetworkMatches()).filter((m) => m.id === forLead.id || m.id === forSupply.id);
    expect(mine.map((m) => m.status).sort()).toEqual(["open", "won"]);
  });
});
