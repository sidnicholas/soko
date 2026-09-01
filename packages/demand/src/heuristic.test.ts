import { describe, it, expect } from "vitest";
import { heuristicDemandSpec } from "./heuristic";

describe("heuristicDemandSpec", () => {
  it("extracts category, ceiling budget, urgency, and fulfillment from free text", () => {
    const s = heuristicDemandSpec({ text: "Need a 27-inch 4K monitor under $220, delivered this week." });
    expect(s.what.description).toContain("monitor");
    expect(s.budget.maximum).toEqual({ amount: 22000, currency: "USD" });
    expect(s.budget.target).toBeUndefined();
    expect(s.budget.flexible).toBe(false);
    expect(s.quality.constraints).toContainEqual({ field: "category", operator: "eq", value: "electronics", hard: false });
    expect(s.timing.urgency).toBe("days");
    expect(s.fulfillment.type).toBe("ship");
  });

  it("treats a bare price as a target and a cue price as a maximum", () => {
    expect(heuristicDemandSpec({ text: "I'll pay $500 for a desk" }).budget.target).toEqual({ amount: 50000, currency: "USD" });
    expect(heuristicDemandSpec({ text: "desk, budget $500" }).budget.maximum).toEqual({ amount: 50000, currency: "USD" });
  });

  it("marks budget flexible and category empty when nothing is stated", () => {
    const s = heuristicDemandSpec({ text: "looking for something interesting" });
    expect(s.budget.flexible).toBe(true);
    expect(s.budget.maximum).toBeUndefined();
    expect(s.budget.target).toBeUndefined();
    expect(s.quality.constraints).toEqual([]);
    expect(s.timing.urgency).toBe("flexible");
  });

  it("detects immediate urgency, pickup fulfillment, and vehicle category", () => {
    const s = heuristicDemandSpec({ text: "need a car ASAP, local pickup" });
    expect(s.timing.urgency).toBe("immediate");
    expect(s.fulfillment.type).toBe("pickup");
    expect(s.quality.constraints[0]?.value).toBe("vehicles");
  });

  it("honors the currency hint on inferred budgets", () => {
    const s = heuristicDemandSpec({ text: "phone under $300", hints: { currency: "EUR" } });
    expect(s.budget.maximum).toEqual({ amount: 30000, currency: "EUR" });
  });
});
