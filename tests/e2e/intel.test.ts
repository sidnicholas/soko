import { describe, it, expect, afterAll } from "vitest";
import type { SearchProvider, WebSearchResult } from "@opportunity-os/connectors-sdk";
import { closeDb, getDb, listIntelQueue, listIntelQueryYield, intelStats } from "@opportunity-os/db";
import { LlmGateway, type LlmProvider } from "@opportunity-os/llm-gateway";
import { runIntelCycle } from "@opportunity-os/intel";

/**
 * AIOOS vertical slice end to end against a live Postgres, with a stubbed
 * search provider and a stubbed model (no paid calls): signal → lead →
 * opposite side → deterministic verification/economics/why-paid → queue.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = Date.now();

const PROBLEM_URL = `https://forum.example.com/t/ga4-broken-${RUN}`;
const DEMAND_URL = `https://classifieds.example.com/wtb-forklift-${RUN}`;
const SUPPLY_URL = `https://liquidation.example.com/forklifts-${RUN}`;
const CARRY_URL = `https://forum.example.com/t/divi-broken-${RUN}`;
const recent = new Date(Date.now() - 86_400_000).toISOString();

function result(url: string, title: string, snippet: string): WebSearchResult {
  return { url, title, snippet, hostname: new URL(url).hostname, publishedAt: recent, ageText: "1 day ago", provider: "stub" };
}

const stubSearch: SearchProvider = {
  id: "stub",
  costPerQueryUsd: 0.005,
  async search(q) {
    if (q.query === "forklift for sale near Dayton") return [result(SUPPLY_URL, "3 forklifts — warehouse closing", "Toyota 5k lb forklifts, $6,500 each")];
    return [
      result(PROBLEM_URL, "GA4 stopped recording purchases", "Our Shopify store's GA4 shows zero purchases since Monday, ad spend is wasted. Owner here, any help?"),
      result(DEMAND_URL, "WTB: 5,000 lb forklift", "Small warehouse in Dayton OH needs a used 5k forklift this week. Reply via listing."),
    ];
  },
};

/** Answers detection and assessment prompts with canned, schema-valid JSON. */
class StubModel implements LlmProvider {
  readonly name = "stub";
  async complete(req: { system?: string; prompt: string }) {
    const isDetection = req.system?.includes("signal-detection") ?? false;
    let text: string;
    if (isDetection) {
      text = JSON.stringify({
        leads: [
          { index: 0, kind: "problem", title: "Shopify store GA4 not recording purchases", summary: "Owner reports GA4 purchases at zero since Monday while ads run.", item: "GA4 purchase tracking", category: null, quantity: null, location: null, deadline: null, price_usd: null, urgency: "high", credibility: 0.8, contact: { channel: "profile", value: null, label: "source_fact" }, facts: [{ field: "problem", value: "GA4 zero purchases", label: "source_fact" }], opposite_queries: [] },
          { index: 1, kind: "demand", title: "Warehouse wants a used 5k lb forklift", summary: "Dayton OH warehouse needs a used 5,000 lb forklift this week.", item: "forklift", category: "industrial equipment", quantity: "1", location: "Dayton, OH", deadline: "this week", price_usd: null, urgency: "high", credibility: 0.7, contact: { channel: "marketplace_message", value: null, label: "source_fact" }, facts: [], opposite_queries: ["forklift for sale near Dayton"] },
        ],
      });
    } else if (req.prompt.includes("Lead kind: problem")) {
      text = JSON.stringify({
        counterparty_found: true, counter_index: null, service_key: "analytics_tracking", title: "Fix GA4 purchase tracking for a Shopify store",
        match_rationale: "Observed tracking failure matches the analytics service.", evidence: "strong",
        economics: { gross_transaction_usd: null, costs_usd: null, user_compensation_usd: [300, 800], capital_required_usd: 0, time_hours: [3, 8], notes: "Typical repair" },
        monetization: { payer: "Store owner", mechanism: "fixed_service_fee", timing: "50% upfront, 50% on fix", value_added: "Restore purchase attribution" },
        probability: [0.15, 0.35], regulatory: [], fraud: [], contact: { channel: "profile", value: null, label: "source_fact" },
        factors: [{ name: "urgent", effect: "+", note: "ads running blind" }], invalidators: ["already fixed"],
        outreach: { primary: "Saw your post about GA4 showing zero purchases — happy to diagnose today.", secondary: null },
      });
    } else {
      text = JSON.stringify({
        counterparty_found: true, counter_index: 0, service_key: null, title: "Connect Dayton forklift buyer with liquidation seller",
        match_rationale: "Seller has 5k forklifts; buyer needs one this week.", evidence: "plausible",
        economics: { gross_transaction_usd: [6000, 7000], costs_usd: [0, 200], user_compensation_usd: [200, 500], capital_required_usd: 0, time_hours: [2, 6], notes: "Sourcing fee" },
        monetization: { payer: null, mechanism: null, timing: null, value_added: "introduction" },
        probability: [0.05, 0.2], regulatory: [], fraud: [], contact: { channel: "marketplace_message", value: null, label: "source_fact" },
        factors: [], invalidators: ["seller sold out"], outreach: { primary: "Hi — saw you need a 5k forklift.", secondary: "Hi — buyer nearby." },
      });
    }
    return { text, inputTokens: 1000, outputTokens: 300, usd: 0.01, model: "stub-1" };
  }
}

describe.skipIf(!HAS_DB)("intel vertical slice (live postgres)", () => {
  afterAll(async () => {
    await getDb().deleteFrom("intel_leads").where("url", "in", [PROBLEM_URL, DEMAND_URL, CARRY_URL]).execute();
    await closeDb();
  });

  it("turns search signals into bucketed, explained candidates within budget", async () => {
    const llm = new LlmGateway([new StubModel()], {
      profiles: {
        extraction: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 },
        research_synthesis: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 },
      },
    });
    const result = await runIntelCycle({ search: stubSearch, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 1, maxAssessments: 5 });

    expect(result.status).toBe("completed");
    expect(result.leadsFound).toBe(2);
    expect(result.candidates).toBe(2);
    // 1 discovery query + 1 opposite-side query; 1 detection + 2 assessments.
    expect(result.searchCalls).toBe(2);
    expect(result.llmCalls).toBe(3);

    const { open } = await listIntelQueue();
    const problem = open.find((c) => c.lead_url === PROBLEM_URL)!;
    const demand = open.find((c) => c.lead_url === DEMAND_URL)!;

    // Problem → service: payer + mechanism named, fresh, reachable, zero capital → ACT NOW.
    expect(problem.bucket).toBe("act_now");
    expect(problem.match_kind).toBe("problem_to_service");
    expect(problem.service_key).toBe("analytics_tracking");
    expect(Number(problem.ev_high_usd)).toBeGreaterThan(0);
    expect((problem.explanation as { factors: unknown[] }).factors).toHaveLength(8);

    // Demand → supply found, but nobody named to pay: monetization unresolved → WATCH, EV 0.
    expect(demand.bucket).toBe("watch");
    expect(demand.counter_url).toBe(SUPPLY_URL);
    expect(Number(demand.ev_high_usd)).toBe(0);
    expect((demand.monetization as { note: string }).note).toBe("Potential match — monetization unresolved");

    const stats = await intelStats();
    expect(stats.runs).toBeGreaterThanOrEqual(1);
    expect(stats.spentTotalUsd).toBeGreaterThan(0);
  });

  it("re-surfaced pages cost no model call, and an exhausted budget stops before spending", async () => {
    const llm = new LlmGateway([new StubModel()], { profiles: { extraction: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 } } });
    const again = await runIntelCycle({ search: stubSearch, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 1, maxAssessments: 0 });
    expect(again.llmCalls).toBe(0);
    expect(again.leadsFound).toBe(0);

    const broke = await runIntelCycle({ search: stubSearch, llm, dailyBudgetUsd: 0, runsPerDay: 1, queriesPerRun: 3, maxAssessments: 3 });
    expect(broke.status).toBe("budget_exhausted");
    expect(broke.searchCalls).toBe(0);
  });

  it("assesses a lead left over from an earlier run, and reports per-query yield", async () => {
    const carrySearch: SearchProvider = {
      id: "stub",
      costPerQueryUsd: 0.005,
      async search() {
        return [result(CARRY_URL, "Divi site broken after update", "Our Divi theme broke after updating, homepage blank. Owner, need help.")];
      },
    };
    class CarryModel implements LlmProvider {
      readonly name = "stub";
      async complete(req: { system?: string; prompt: string }) {
        const text = req.system?.includes("signal-detection")
          ? JSON.stringify({ leads: [{ index: 0, kind: "problem", title: "Divi site blank after update", summary: "Owner's Divi homepage blank since update.", item: null, category: null, quantity: null, location: null, deadline: null, price_usd: null, urgency: "high", credibility: 0.9, contact: { channel: "profile", value: null, label: "source_fact" }, facts: [], opposite_queries: [] }] })
          : JSON.stringify({
              counterparty_found: true, counter_index: null, service_key: "website_repair", title: "Repair Divi site after update", match_rationale: "Website repair service.", evidence: "strong",
              economics: { gross_transaction_usd: null, costs_usd: null, user_compensation_usd: [200, 600], capital_required_usd: 0, time_hours: [2, 5], notes: "" },
              monetization: { payer: "Site owner", mechanism: "fixed_service_fee", timing: "on completion", value_added: "Restore the site" },
              probability: [0.2, 0.4], regulatory: [], fraud: [], contact: { channel: "profile", value: null, label: "source_fact" }, factors: [], invalidators: [], outreach: { primary: "Hi", secondary: null },
            });
        return { text, inputTokens: 100, outputTokens: 50, usd: 0.001, model: "stub-1" };
      }
    }
    const llm = new LlmGateway([new CarryModel()], {
      profiles: { extraction: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 }, research_synthesis: { providers: ["stub"], maxUsd: 1, timeoutMs: 5000 } },
    });

    // Run 1 detects the lead but has no assessment slots.
    const first = await runIntelCycle({ search: carrySearch, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 1, maxAssessments: 0 });
    expect(first.leadsFound).toBe(1);
    expect(first.candidates).toBe(0);

    // Run 2 finds nothing new (same page) but picks the leftover lead up.
    const second = await runIntelCycle({ search: carrySearch, llm, dailyBudgetUsd: 1000, runsPerDay: 1, queriesPerRun: 1, maxAssessments: 5 });
    expect(second.leadsFound).toBe(0);
    expect(second.candidates).toBeGreaterThanOrEqual(1);
    expect((second.notes.assessmentPool as { carriedOverAssessed: number }).carriedOverAssessed).toBeGreaterThanOrEqual(1);
    const { open } = await listIntelQueue();
    expect(open.find((c) => c.lead_url === CARRY_URL)?.bucket).toBe("act_now");

    const yieldRows = await listIntelQueryYield();
    const productive = yieldRows.filter((r) => r.leads > 0);
    expect(productive.length).toBeGreaterThan(0);
    expect(productive[0]!.searches).toBeGreaterThan(0);
  });
});
