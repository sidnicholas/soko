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
});
