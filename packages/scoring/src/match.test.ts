import { describe, it, expect } from "vitest";
import { matchDemandToSupply, MATCH_MIN_TOTAL, MATCH_VERSION, type MatchDemand } from "./match";

// Mirrors the fixture demand dem-2001 (§ connectors-sdk fixtures).
const MONITOR_DEMAND: MatchDemand = {
  description: "Need a 27-inch 4K monitor under $220, delivered this week.",
  category: "electronics",
  targetPriceMinor: 22000,
  maxBudgetMinor: null,
};

describe("matchDemandToSupply", () => {
  it("scores an in-category, in-budget, term-overlapping pair highly", () => {
    const m = matchDemandToSupply(MONITOR_DEMAND, {
      title: "Refurbished 27in 4K monitor",
      description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
      category: "electronics",
      priceMinor: 18900,
    });

    expect(m.version).toBe(MATCH_VERSION);
    expect(m.semantic).toBeCloseTo(2 / 3, 5);
    expect(m.constraint).toBe(1);
    expect(m.geography).toBe(1);
    expect(m.timing).toBe(1);
    expect(m.total).toBeCloseTo(0.8, 5);
    expect(m.total).toBeGreaterThanOrEqual(MATCH_MIN_TOTAL);
    expect(m.explanation.categoryAligned).toBe(true);
    expect(m.explanation.withinBudget).toBe(true);
    expect(m.explanation.sharedTerms).toEqual(["inch", "monitor"]);
  });

  it("gates a cross-category pair below the opportunity threshold", () => {
    const chairs = matchDemandToSupply(MONITOR_DEMAND, {
      title: "Pallet of stackable dining chairs (24)",
      description: "Commercial-grade stackable chairs, light scuffs, local pickup.",
      category: "furniture",
      priceMinor: 42000,
    });

    expect(chairs.semantic).toBe(0);
    expect(chairs.explanation.categoryAligned).toBe(false);
    expect(chairs.explanation.withinBudget).toBe(false);
    expect(chairs.total).toBeLessThan(MATCH_MIN_TOTAL);
  });

  it("penalizes an over-budget in-category pair below a within-budget one", () => {
    const within = matchDemandToSupply(MONITOR_DEMAND, {
      title: "Refurbished 27in 4K monitor",
      description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
      category: "electronics",
      priceMinor: 18900,
    });
    const over = matchDemandToSupply(MONITOR_DEMAND, {
      title: "Refurbished 27in 4K monitor",
      description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
      category: "electronics",
      priceMinor: 30000,
    });

    expect(over.explanation.withinBudget).toBe(false);
    expect(over.constraint).toBeCloseTo(22000 / 30000, 5);
    expect(over.total).toBeGreaterThanOrEqual(MATCH_MIN_TOTAL);
    expect(over.total).toBeLessThan(within.total);
  });

  it("is deterministic: identical inputs yield an identical result", () => {
    const supply = {
      title: "Refurbished 27in 4K monitor",
      description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
      category: "electronics",
      priceMinor: 18900,
    };
    expect(matchDemandToSupply(MONITOR_DEMAND, supply)).toEqual(matchDemandToSupply(MONITOR_DEMAND, supply));
  });

  it("degrades to neutral budget fit when price or budget is unknown", () => {
    const m = matchDemandToSupply(
      { description: "generic widget", category: null, targetPriceMinor: null, maxBudgetMinor: null },
      { title: "widget", description: "a widget", category: null, priceMinor: null },
    );
    expect(m.constraint).toBe(0.5);
    expect(m.explanation.withinBudget).toBeNull();
  });
});
