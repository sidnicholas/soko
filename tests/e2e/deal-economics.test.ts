import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SearchProvider, WebSearchResult } from "@opportunity-os/connectors-sdk";
import {
  closeDb,
  getDb,
  listEconomicsVersions,
  listEvidence,
  listIntelQueue,
  listSources,
  reviewSource,
  setSourceStatus,
  upsertSubmittedSource,
  type RegistrySource,
} from "@opportunity-os/db";
import { LlmGateway, type LlmProvider } from "@opportunity-os/llm-gateway";
import { SOURCE_POLICY_VERSION, policyGaps, runIntelCycle, vetSource } from "@opportunity-os/intel";
import { rankDeals, type DealEconomics } from "@opportunity-os/scoring";

/**
 * PRD v2 FR-04 against a live Postgres: delivered-cost economics decide the
 * bucket (a big headline spread eaten by landed costs is rejected), every
 * assessment stores a numbered economics version, the evidence it rests on
 * (with content hashes) and opportunity.economics_updated.v1, and the queue
 * ranks profit first.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const SRC = `econ-${RUN}.example.com`;
const URL = { headline: `https://${SRC}/container-of-tvs`, steady: `https://${SRC}/office-chairs`, buyerA: `https://a-${RUN}.example.com/buy-tvs`, buyerB: `https://b-${RUN}.example.com/buy-chairs` };
const STAFF = { type: "user" as const, id: randomUUID() };
const POLICY = { policyGaps: (s: RegistrySource) => policyGaps(s), policyVersion: SOURCE_POLICY_VERSION };
const recent = new Date(Date.now() - 86_400_000).toISOString();
const r = (url: string, title: string, snippet: string): WebSearchResult => ({ url, title, snippet, hostname: new globalThis.URL(url).hostname, publishedAt: recent, ageText: "1 day ago", provider: "stub" });

const search: SearchProvider = {
  id: "stub",
  costPerQueryUsd: 0.005,
  async search(q) {
    if (q.query === `site:${SRC} overstock`) return [r(URL.headline, "Container of 400 TVs, overstock", "$100k under retail, buyer pays freight from Shenzhen"), r(URL.steady, "120 office chairs, overstock", "Closeout at $40 each, local pickup")];
    if (q.query === `tv buyers ${RUN}`) return [r(URL.buyerA, "Wanted: TVs in bulk", "Retailer buying TVs")];
    if (q.query === `chair buyers ${RUN}`) return [r(URL.buyerB, "Wanted: office chairs", "Coworking space furnishing")];
    return [];
  },
};

const NO_TERMS = { moq: null, price_breaks: null, condition: null, shipping_terms: null, expiry: null, capacity: null };
const supply = (index: number, title: string, opposite: string) => ({
  index, kind: "supply", title, summary: title, item: null, category: null, quantity: null, location: null, deadline: null, price_usd: null,
  urgency: "high", credibility: 0.9, contact: { channel: "marketplace_message", value: null, label: "source_fact" },
  facts: [{ field: "quantity", value: title, label: "source_fact" }], opposite_queries: [opposite], signal_type: "surplus", evidence_level: "observed", supply_terms: NO_TERMS, title_unverified: false,
});

class StubModel implements LlmProvider {
  readonly name = "stub";
  async complete(req: { system?: string; prompt: string }) {
    let text: string;
    if (req.system?.includes("signal-detection")) {
      text = JSON.stringify({ skipped: [], hypotheses: [], leads: [supply(0, "400 TVs, overstock container", `tv buyers ${RUN}`), supply(1, "120 office chairs, closeout", `chair buyers ${RUN}`)] });
    } else {
      const tvs = req.prompt.includes("container-of-tvs");
      const base = {
        lead_is_competitor_offer: false, counterparty_found: true, counter_index: 0, service_key: null, match_rationale: "Buyer found.", evidence: "verified",
        probability: [0.4, 0.6], regulatory: [], fraud: [], contact: { channel: "marketplace_message", value: null, label: "source_fact" },
        factors: [], invalidators: [], outreach: { primary: "Hello", secondary: "Hello" },
      };
      text = JSON.stringify(
        tvs
          ? {
              ...base, title: "Resell the TV container",
              // $100k headline spread (sale $300k − purchase $200k) and $110k of landed costs on top.
              economics: { gross_transaction_usd: [300000, 300000], costs_usd: null, user_compensation_usd: [300000, 300000], capital_required_usd: 0, time_hours: [10, 20], notes: "", mode: "principal",
                cost_lines: [{ kind: "purchase", usd: [200000, 200000], label: "source_fact", note: null }, { kind: "freight", usd: [60000, 60000], label: "estimate", note: null }, { kind: "duties", usd: [40000, 40000], label: "estimate", note: null }, { kind: "insurance", usd: [10000, 10000], label: "estimate", note: null }],
                days_to_cash: [30, 60], cross_currency: false },
              monetization: { payer: "Retailer", mechanism: "reseller_margin", timing: "on delivery", value_added: "Import and resell" },
            }
          : {
              ...base, title: "Broker the chair closeout",
              economics: { gross_transaction_usd: [4800, 4800], costs_usd: null, user_compensation_usd: [400, 600], capital_required_usd: 0, time_hours: [2, 4], notes: "", mode: "brokerage", cost_lines: [], days_to_cash: [7, 21], cross_currency: false },
              monetization: { payer: "Seller", mechanism: "commission", timing: "on sale", value_added: "Found the buyer" },
            },
      );
    }
    return { text, inputTokens: 100, outputTokens: 50, usd: 0.001, model: "stub-1" };
  }
}
const llm = new LlmGateway([new StubModel()], {
  profiles: { extraction: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 }, research_synthesis: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 } },
});
const candidateFor = async (url: string) =>
  (await getDb().selectFrom("intel_candidates as c").innerJoin("intel_leads as l", "l.id", "c.lead_id").select(["c.id", "c.lead_id", "c.bucket", "c.reject_reason", "c.economics"]).where("l.url", "=", url).executeTakeFirstOrThrow());

describe.skipIf(!HAS_DB)("deal economics and evidence (live postgres)", () => {
  beforeAll(async () => {
    for (const s of await listSources({ kind: "search_venue", status: "active" })) await setSourceStatus(s.id, "paused", "test_isolation", { type: "system", id: null }, POLICY);
    const [v] = vetSource({ name: SRC, domain: SRC, side: "supply", search_topics: ["overstock"], access_method: "public" }).vetted;
    const { source } = await upsertSubmittedSource({ ...v!, origin: "staff_upload" }, STAFF);
    await reviewSource({ sourceId: source.id, decision: "approved", permissionBasis: "public_search_index", robotsTosAssessment: "Index only.", dataUseConstraints: null, termsReviewDueAt: new Date(Date.now() + 86_400_000 * 30).toISOString(), notes: null, reviewer: STAFF, reviewerLabel: null, ...POLICY });
  });

  afterAll(async () => {
    await getDb().deleteFrom("intel_leads").where("url", "in", [URL.headline, URL.steady]).execute();
    await getDb().deleteFrom("source_registry").where("domain", "=", SRC).execute();
    await getDb().updateTable("source_registry").set({ status: "active", status_reason: null }).where("origin", "=", "builtin").execute();
    await closeDb();
  });

  it("rejects a headline spread that landed costs eat, keeps the profitable deal, and ranks profit first", async () => {
    const { runId } = await runIntelCycle({ search, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 5, maxAssessments: 5, lane: "supply", counterpartSearches: 5, hypothesisChecks: 0 });

    // Which model did each stage, per run and per candidate (gate follow-up, 2026-10-17).
    const run = await getDb().selectFrom("intel_runs").select("notes").where("id", "=", runId).executeTakeFirstOrThrow();
    expect((run.notes as { models: Record<string, { calls: number }> }).models).toMatchObject({ "detection:stub/stub-1": { calls: 1 }, "assessment:stub/stub-1": { calls: 2 } });

    const tvs = await candidateFor(URL.headline);
    const deal = (tvs.economics as { deal: DealEconomics }).deal;
    expect(deal.grossSpreadUsd).toEqual([100000, 100000]);
    expect(deal.netProfitUsd[1]).toBeLessThan(0);
    expect(tvs).toMatchObject({ bucket: "rejected", reject_reason: "negative_net_economics" });

    const chairs = await candidateFor(URL.steady);
    const chairDeal = (chairs.economics as { deal: DealEconomics }).deal;
    expect(chairDeal).toMatchObject({ mode: "brokerage", tier: "medium", gates: [] });
    expect(chairDeal.costs.map((c) => [c.kind, c.label])).toEqual([["payment_fees", "default_assumption"]]);
    expect(chairs.bucket).not.toBe("rejected");
    const explained = await getDb().selectFrom("intel_candidates").select("explanation").where("id", "=", chairs.id).executeTakeFirstOrThrow();
    expect((explained.explanation as { assessedBy: string }).assessedBy).toBe("stub/stub-1");

    const { open } = await listIntelQueue();
    const ours = open.filter((c) => [chairs.id].includes(c.id));
    expect(rankDeals(ours, (c) => (c.economics as { deal?: DealEconomics }).deal ?? null)[0]!.id).toBe(chairs.id);
  });

  it("stores a numbered economics version, the evidence with hashes, and the event, per assessment", async () => {
    const chairs = await candidateFor(URL.steady);
    const versions = await listEconomicsVersions("intel_candidate", chairs.id);
    expect(versions.map((v) => [v.version, v.model_version, v.tier])).toEqual([[1, "deal-economics-1", "medium"]]);

    const leadEvidence = await listEvidence("intel_lead", chairs.lead_id);
    expect(leadEvidence.map((e) => [e.kind, e.label])).toEqual([["source_page", "source_fact"], ["fact", "source_fact"]]);
    expect(leadEvidence[0]).toMatchObject({ url: URL.steady, title: "120 office chairs, overstock", excerpt: "Closeout at $40 each, local pickup" });
    expect(leadEvidence.every((e) => /^[0-9a-f]{64}$/.test(e.content_hash))).toBe(true);
    const candidateEvidence = await listEvidence("intel_candidate", chairs.id);
    expect(candidateEvidence.map((e) => [e.kind, e.url])).toEqual(expect.arrayContaining([["counterpart", URL.buyerB], ["contact", URL.steady]]));

    const events = await getDb().selectFrom("outbox").select("payload").where("event_name", "=", "opportunity.economics_updated.v1").where("aggregate_id", "=", chairs.id).execute();
    expect(events.map((e) => (e.payload as { version: number }).version)).toEqual([1]);

    // Re-assessing the same lead appends version 2; version 1 is kept.
    await getDb().updateTable("intel_leads").set({ status: "new" }).where("id", "=", chairs.lead_id).execute();
    await runIntelCycle({ search, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 0, maxAssessments: 5, lane: "supply", counterpartSearches: 0, hypothesisChecks: 0 });
    expect((await listEconomicsVersions("intel_candidate", chairs.id)).map((v) => v.version)).toEqual([2, 1]);
    // The same evidence is not stored twice.
    expect((await listEvidence("intel_candidate", chairs.id)).length).toBe(candidateEvidence.length);
  });
});
