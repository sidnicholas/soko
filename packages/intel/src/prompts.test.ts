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

  it("survives every off-spec field seen in live runs (2026-10-04 00:00 UTC)", async () => {
    const { AssessmentSchema } = await import("./prompts");
    // Detection: free-text contact channel, numeric fact value, invalid kind dropped.
    const det = DetectionSchema.parse({
      skipped: [],
      leads: [
        {
          index: 0, kind: "problem", title: "t", summary: "s", urgency: "urgent", credibility: 1.4,
          contact: { channel: "Shopify community post; no direct contact provided", value: null, label: "source_fact" },
          facts: [{ field: "orders_lost", value: 12, label: "source_fact" }], opposite_queries: [],
        },
        { index: 1, kind: "opportunity", title: "x", summary: "y", urgency: "low", credibility: 0.5, contact: null, facts: [], opposite_queries: [] },
      ],
    });
    expect(det.leads).toHaveLength(1);
    expect(det.leads[0]!.contact?.channel).toBe("unknown");
    expect(det.leads[0]!.facts[0]!.value).toBe("12");
    expect(det.leads[0]!.urgency).toBe("medium");
    expect(det.leads[0]!.credibility).toBe(1);

    // Assessment: capital as a range, regulatory flags as plain strings, off-list mechanism.
    const a = AssessmentSchema.parse({
      counterparty_found: false, counter_index: null, service_key: null, title: "t", match_rationale: "r", evidence: "weak",
      economics: { gross_transaction_usd: [1, 2, 3], costs_usd: null, user_compensation_usd: [0, 0], capital_required_usd: [5000, 20000], time_hours: [10, 20], notes: "" },
      monetization: { payer: "Agency", mechanism: "finder_fee", timing: null, value_added: "intro" },
      probability: [0.01, 0.05],
      regulatory: ["Federal contractor registration (SAM.gov) required"],
      fraud: [], contact: null, factors: [], invalidators: [], outreach: { primary: null, secondary: null },
    });
    expect(a.economics.capital_required_usd).toBe(20000);
    expect(a.economics.gross_transaction_usd).toEqual([1, 3]);
    expect(a.regulatory).toEqual([{ flag: "Federal contractor registration (SAM.gov) required", reason: "Federal contractor registration (SAM.gov) required" }]);
    expect(a.monetization.mechanism).toBeNull();
    expect(a.evidence).toBe("speculative");
  });

  it("wire schemas convert to JSON Schema for structured outputs", async () => {
    const { z } = await import("zod/v4");
    const { DetectionWire, AssessmentWire } = await import("./prompts");
    for (const wire of [DetectionWire, AssessmentWire]) {
      const js = z.toJSONSchema(wire) as { type: string; properties: Record<string, unknown> };
      expect(js.type).toBe("object");
      expect(Object.keys(js.properties).length).toBeGreaterThanOrEqual(2);
    }
  });
});
