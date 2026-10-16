import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SearchProvider, WebSearchResult } from "@opportunity-os/connectors-sdk";
import {
  closeDb,
  getDb,
  listDemandHypotheses,
  listIntelQueue,
  listSources,
  reviewSource,
  setSourceStatus,
  upsertSubmittedSource,
  type RegistrySource,
} from "@opportunity-os/db";
import { LlmGateway, type LlmProvider } from "@opportunity-os/llm-gateway";
import { SOURCE_POLICY_VERSION, policyGaps, runIntelCycle, vetSource } from "@opportunity-os/intel";

/**
 * PRD v2 FR-02 / FR-03 against a live Postgres, with stubbed search and model:
 * supply and demand lanes, observed vs inferred routing, the title caveat on
 * liquidation stock, the WATCH cap and outreach suppression for inferred
 * signals, the stored counterpart search, and the hypothesis watchlist
 * (created, confirmed by an observed lead, expired).
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const SUP = `sup-${RUN}.example.com`;
const DEM = `dem-${RUN}.example.com`;
const URL = {
  liquidation: `https://${SUP}/liquidation-pallets`,
  inferredSurplus: `https://${SUP}/plant-closing-news`,
  wanted: `https://${DEM}/wtb-centrifuge`,
  hiring: `https://${DEM}/lab-expanding-hiring`,
  inferredNeed: `https://${DEM}/complaint-thread`,
  rfq: `https://${DEM}/rfq-centrifuge-now`,
  buyer: `https://buyers-${RUN}.example.com/wanted-pallets`,
  supplier: `https://suppliers-${RUN}.example.com/centrifuges`,
};
const Q = {
  supply: `site:${SUP} closeout`,
  demand: `site:${DEM} wanted`,
  buyers: `buyers for pallets ${RUN}`,
  scrapBuyers: `buyers for scrap ${RUN}`,
  suppliers: `suppliers of centrifuge ${RUN}`,
  check: `centrifuge rfq ${RUN}`,
};
const STAFF = { type: "user" as const, id: randomUUID() };
const POLICY = { policyGaps: (s: RegistrySource) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION };
const recent = new Date(Date.now() - 86_400_000).toISOString();
const r = (url: string, title: string, snippet: string): WebSearchResult => ({ url, title, snippet, hostname: new globalThis.URL(url).hostname, publishedAt: recent, ageText: "1 day ago", provider: "stub" });

const searched: string[] = [];
const search: SearchProvider = {
  id: "stub",
  costPerQueryUsd: 0.005,
  async search(q) {
    searched.push(q.query);
    if (q.query === Q.supply) return [r(URL.liquidation, "Liquidation: 40 pallets of shrink wrap", "Warehouse liquidation, MOQ 5 pallets, $120/pallet, FOB Dayton"), r(URL.inferredSurplus, "Plant closing in March", "Local packaging plant to close")];
    if (q.query === Q.demand) return [r(URL.wanted, "WTB: benchtop centrifuge", "Lab buying a used benchtop centrifuge this month"), r(URL.hiring, "Lab doubling its team", "Biotech lab hiring 20 technicians for a new site"), r(URL.inferredNeed, "Our centrifuge keeps failing", "Third breakdown this year")];
    if (q.query === Q.buyers) return [r(URL.buyer, "Wanted: shrink wrap pallets", "Distributor buying shrink wrap")];
    if (q.query === Q.suppliers) return [r(URL.supplier, "Used centrifuges in stock", "Refurbished benchtop centrifuges")];
    if (q.query === Q.check) return [r(URL.rfq, "RFQ: 2 benchtop centrifuges", "Biotech lab requests quotes for two centrifuges")];
    return [];
  },
};

const NO_TERMS = { moq: null, price_breaks: null, condition: null, shipping_terms: null, expiry: null, capacity: null };
const lead = (index: number, over: Record<string, unknown>) => ({
  index, title: "t", summary: "s", item: null, category: null, quantity: null, location: null, deadline: null, price_usd: null,
  urgency: "high", credibility: 0.9, contact: { channel: "marketplace_message", value: null, label: "source_fact" }, facts: [],
  opposite_queries: [], supply_terms: NO_TERMS, title_unverified: false, ...over,
});

/** Detection by URL; assessment always strong, two-sided and paid, so only the rules under test hold a candidate back. */
class StubModel implements LlmProvider {
  readonly name = "stub";
  async complete(req: { system?: string; prompt: string }) {
    let text: string;
    if (req.system?.includes("signal-detection")) {
      const at = new Map([...req.prompt.matchAll(/\[(\d+)\][^\n]*\nurl: (\S+)/g)].map((m) => [m[2]!, Number(m[1])]));
      const leads: unknown[] = [];
      const hypotheses: unknown[] = [];
      const i = (u: string) => at.get(u);
      if (i(URL.liquidation) !== undefined) leads.push(lead(i(URL.liquidation)!, { kind: "supply", title: "40 pallets shrink wrap, liquidation", signal_type: "liquidation", evidence_level: "observed", title_unverified: true, supply_terms: { ...NO_TERMS, moq: "5 pallets", price_breaks: "$120/pallet", shipping_terms: "FOB Dayton" }, opposite_queries: [Q.buyers] }));
      if (i(URL.inferredSurplus) !== undefined) leads.push(lead(i(URL.inferredSurplus)!, { kind: "supply", title: "Plant closure implies surplus packaging", signal_type: "surplus", evidence_level: "inferred", opposite_queries: [Q.scrapBuyers] }));
      if (i(URL.wanted) !== undefined) leads.push(lead(i(URL.wanted)!, { kind: "demand", title: "Lab wants a benchtop centrifuge", signal_type: "purchase_request", evidence_level: "observed", opposite_queries: [Q.suppliers] }));
      if (i(URL.inferredNeed) !== undefined) leads.push(lead(i(URL.inferredNeed)!, { kind: "demand", title: "Lab may need a new centrifuge", signal_type: "unmet_need", evidence_level: "inferred", opposite_queries: [Q.suppliers] }));
      if (i(URL.hiring) !== undefined) hypotheses.push({ index: i(URL.hiring)!, signal_type: "hiring_expansion", hypothesis: "Lab may buy centrifuges for its new site", basis: "Hiring 20 technicians for a new site", item: "centrifuge", location: null, confidence: 0.6, check_query: Q.check, revisit_days: 7, facts: [] });
      if (i(URL.rfq) !== undefined) leads.push(lead(i(URL.rfq)!, { kind: "demand", title: "RFQ for two centrifuges", signal_type: "rfq", evidence_level: "observed", opposite_queries: [Q.suppliers] }));
      text = JSON.stringify({ skipped: [], leads, hypotheses });
    } else {
      text = JSON.stringify({
        lead_is_competitor_offer: false, counterparty_found: true, counter_index: 0, service_key: null, title: "Broker the match", match_rationale: "Both sides found.", evidence: "verified",
        economics: { gross_transaction_usd: [4000, 5000], costs_usd: [0, 0], user_compensation_usd: [300, 600], capital_required_usd: 0, time_hours: [2, 6], notes: "" },
        monetization: { payer: "Seller", mechanism: "commission", timing: "on sale", value_added: "Found the buyer" },
        probability: [0.3, 0.5], regulatory: [], fraud: [], contact: { channel: "marketplace_message", value: null, label: "source_fact" },
        factors: [], invalidators: [], outreach: { primary: "Hello", secondary: "Hello" },
      });
    }
    return { text, inputTokens: 100, outputTokens: 50, usd: 0.001, model: "stub-1" };
  }
}
const llm = new LlmGateway([new StubModel()], {
  profiles: { extraction: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 }, research_synthesis: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 } },
});
const run = (lane: "supply" | "demand") => runIntelCycle({ search, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 20, maxAssessments: 5, lane, counterpartSearches: 10, hypothesisChecks: 5 });

const leadRow = (url: string) => getDb().selectFrom("intel_leads").selectAll().where("url", "=", url).executeTakeFirst();
const events = async (name: string) => (await getDb().selectFrom("outbox").select(["aggregate_id", "payload"]).where("event_name", "=", name).execute());

describe.skipIf(!HAS_DB)("supply and demand intelligence (live postgres)", () => {
  beforeAll(async () => {
    // Only this file's two sources in the pool.
    for (const s of await listSources({ kind: "search_venue", status: "active" })) await setSourceStatus(s.id, "paused", "test_isolation", { type: "system", id: null }, POLICY);
    for (const [domain, side, topic] of [[SUP, "supply", "closeout"], [DEM, "demand", "wanted"]] as const) {
      const [v] = vetSource({ name: domain, domain, side, search_topics: [topic], access_method: "public" }).vetted;
      const { source } = await upsertSubmittedSource({ ...v!, origin: "staff_upload" }, STAFF);
      await reviewSource({ sourceId: source.id, decision: "approved", permissionBasis: "public_search_index", robotsTosAssessment: "Index only.", dataUseConstraints: null, termsReviewDueAt: new Date(Date.now() + 86_400_000 * 30).toISOString(), notes: null, reviewer: STAFF, reviewerLabel: null, ...POLICY });
    }
  });

  afterAll(async () => {
    await getDb().deleteFrom("source_registry").where("domain", "in", [SUP, DEM]).execute();
    await getDb().updateTable("source_registry").set({ status: "active", status_reason: null }).where("origin", "=", "builtin").execute();
    await getDb().deleteFrom("demand_hypotheses").where("hostname", "=", DEM).execute();
    // Leads left behind would be picked up by later files' counterpart and assessment stages.
    await getDb().deleteFrom("intel_leads").where("url", "in", Object.values(URL)).execute();
    await closeDb();
  });

  it("supply lane: stores terms and evidence level, flags title, finds buyers, caps inferred surplus", async () => {
    searched.length = 0;
    const result = await run("supply");
    expect(result.status).toBe("completed");
    expect(searched).toContain(Q.supply);
    expect(searched).not.toContain(Q.demand);

    const liq = (await leadRow(URL.liquidation))!;
    expect(liq).toMatchObject({ kind: "supply", signal_type: "liquidation", evidence_level: "observed", title_unverified: true, counterpart_status: "found" });
    expect(liq.supply_terms).toMatchObject({ moq: "5 pallets", price_breaks: "$120/pallet", shipping_terms: "FOB Dayton" });
    expect((liq.counterparts as { url: string }[])[0]!.url).toBe(URL.buyer);
    expect((await leadRow(URL.inferredSurplus))!).toMatchObject({ evidence_level: "inferred", counterpart_status: "none_found" });
    const surplus = (await events("surplus.detected.v1")).map((e) => e.aggregate_id);
    expect(surplus).toEqual(expect.arrayContaining([liq.id, (await leadRow(URL.inferredSurplus))!.id]));

    const { open } = await listIntelQueue();
    const liqCandidate = open.find((c) => c.lead_url === URL.liquidation)!;
    // Clear title is not assumed: kept out of ACT NOW despite a strong, paid, two-sided match.
    expect(liqCandidate.bucket).toBe("verify_next");
    expect((liqCandidate.regulatory_flags as { flag: string }[]).map((f) => f.flag)).toContain("title_unverified");
    expect(liqCandidate.counter_url).toBe(URL.buyer);
    const inferred = open.find((c) => c.lead_url === URL.inferredSurplus)!;
    expect(inferred).toMatchObject({ bucket: "watch", reject_reason: "surplus_inferred" });
    expect((inferred.outreach as { primary: string | null }).primary).toBeNull();
  });

  it("demand lane: observed demand is a lead with a supplier search; implied demand is only a hypothesis", async () => {
    searched.length = 0;
    await run("demand");
    expect(searched).toContain(Q.demand);
    expect(searched).not.toContain(Q.supply);
    expect((await leadRow(URL.wanted))!).toMatchObject({ kind: "demand", evidence_level: "observed", counterpart_status: "found" });

    // Neither the hiring post nor the inferred need became a lead or a candidate.
    expect(await leadRow(URL.hiring)).toBeUndefined();
    expect(await leadRow(URL.inferredNeed)).toBeUndefined();
    const { open, rejected } = await listIntelQueue();
    expect([...open, ...rejected].some((c) => c.lead_url === URL.hiring || c.lead_url === URL.inferredNeed)).toBe(false);
    const watch = (await listDemandHypotheses()).filter((h) => h.source_url === URL.hiring || h.source_url === URL.inferredNeed);
    expect(watch.map((h) => [h.source_url, h.status]).sort()).toEqual([[URL.inferredNeed, "watching"], [URL.hiring, "watching"]].sort());
    expect((await events("signal.hypothesis_created.v1")).filter((e) => watch.some((h) => h.id === e.aggregate_id))).toHaveLength(2);
  });

  it("confirms a hypothesis only when an observed lead states the need, and expires the rest", async () => {
    const hiring = (await listDemandHypotheses()).find((h) => h.source_url === URL.hiring)!;
    const need = (await listDemandHypotheses()).find((h) => h.source_url === URL.inferredNeed)!;
    await getDb().updateTable("demand_hypotheses").set({ revisit_at: new Date(Date.now() - 60_000).toISOString() }).where("id", "=", hiring.id).execute();
    await getDb().updateTable("demand_hypotheses").set({ expires_at: new Date(Date.now() - 60_000).toISOString() }).where("id", "=", need.id).execute();

    searched.length = 0;
    await run("demand");
    expect(searched).toContain(Q.check);
    const rfq = (await leadRow(URL.rfq))!;
    expect(rfq).toMatchObject({ kind: "demand", evidence_level: "observed" });
    const after = await listDemandHypotheses();
    expect(after.find((h) => h.id === hiring.id)).toMatchObject({ status: "confirmed", confirmed_lead_id: rfq.id, revisit_count: 1 });
    expect(after.find((h) => h.id === need.id)).toMatchObject({ status: "expired", status_reason: "lifetime_ended" });
  });

  it("records when a known listing is seen again", async () => {
    await run("supply");
    expect(Number((await leadRow(URL.liquidation))!.seen_count)).toBeGreaterThanOrEqual(2);
  });
});
