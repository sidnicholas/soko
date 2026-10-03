import { describe, it, expect } from "vitest";
import { DetectionSchema } from "./prompts";

describe("DetectionSchema", () => {
  it("accepts numbers written as text, and treats unparseable ones as unknown", () => {
    const lead = {
      index: 0, kind: "supply", title: "t", summary: "s", urgency: "low", credibility: "0.7",
      contact: null, facts: [], opposite_queries: [],
    };
    const parsed = DetectionSchema.parse({ leads: [{ ...lead, price_usd: "$6,500" }, { ...lead, price_usd: "call for price" }] });
    expect(parsed.leads[0]!.price_usd).toBe(6500);
    expect(parsed.leads[0]!.credibility).toBe(0.7);
    expect(parsed.leads[1]!.price_usd).toBeNull();
  });

  it("records why results were skipped, mapping unknown labels to other", () => {
    const parsed = DetectionSchema.parse({ skipped: [{ index: "0", reason: "article" }, { index: 1, reason: "listicle" }], leads: [] });
    expect(parsed.skipped).toEqual([{ index: 0, reason: "article" }, { index: 1, reason: "other" }]);
    expect(DetectionSchema.parse({ leads: [] }).skipped).toEqual([]);
  });

  it("turns single-number or null economics into ranges with conservative defaults", async () => {
    const { AssessmentSchema } = await import("./prompts");
    const base = {
      counterparty_found: false, counter_index: null, service_key: null, title: "t", match_rationale: "r", evidence: "plausible",
      monetization: { payer: null, mechanism: null, timing: null, value_added: null }, regulatory: [], fraud: [], contact: null,
      factors: [], invalidators: [], outreach: { primary: null, secondary: null },
    };
    const nulls = AssessmentSchema.parse({ ...base, probability: null, economics: { gross_transaction_usd: null, costs_usd: null, user_compensation_usd: null, capital_required_usd: null, time_hours: null, notes: "" } });
    expect(nulls.economics.user_compensation_usd).toEqual([0, 0]);
    expect(nulls.economics.time_hours).toEqual([40, 120]);
    expect(nulls.economics.capital_required_usd).toBe(1000);
    expect(nulls.probability).toEqual([0, 0]);
    const single = AssessmentSchema.parse({ ...base, probability: [0.1, 0.2], economics: { gross_transaction_usd: 50000, costs_usd: null, user_compensation_usd: "$1,500", capital_required_usd: 0, time_hours: 10, notes: "" } });
    expect(single.economics.user_compensation_usd).toEqual([1500, 1500]);
    expect(single.economics.gross_transaction_usd).toEqual([50000, 50000]);
    expect(single.economics.time_hours).toEqual([10, 10]);
  });
});
