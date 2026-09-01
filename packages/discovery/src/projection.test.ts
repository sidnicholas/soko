import { describe, it, expect } from "vitest";
import type { DemandSpecification } from "@opportunity-os/contracts";
import { projectMissionDemand } from "./projection";

function spec(overrides: Partial<DemandSpecification> = {}): DemandSpecification {
  return {
    what: { description: "27-inch 4K monitor" },
    budget: { target: { amount: 20000, currency: "USD" }, maximum: { amount: 22000, currency: "USD" }, flexible: true },
    quality: { constraints: [] },
    timing: { urgency: "days" },
    payment: { acceptableMethods: ["card"] },
    fulfillment: { type: "ship" },
    flexibility: { substitutesAllowed: true, negotiableFields: [], nonNegotiables: [] },
    negotiationAuthorization: { mayPrepare: true, maySend: false },
    ...overrides,
  };
}

describe("projectMissionDemand", () => {
  it("maps description, budget (max preferred as ceiling), and urgency", () => {
    const d = projectMissionDemand(spec());
    expect(d.description).toBe("27-inch 4K monitor");
    expect(d.targetPriceMinor).toBe(20000);
    expect(d.maxBudgetMinor).toBe(22000);
    expect(d.currency).toBe("USD");
    expect(d.urgencyScore).toBeCloseTo(0.6, 5);
  });

  it("reads category from an explicit quality constraint, else null", () => {
    expect(projectMissionDemand(spec()).category).toBeNull();
    const withCategory = projectMissionDemand(
      spec({ quality: { constraints: [{ field: "category", operator: "eq", value: "electronics", hard: true }] } }),
    );
    expect(withCategory.category).toBe("electronics");
  });

  it("falls back to target currency then USD, and null prices when no budget", () => {
    const noBudget = projectMissionDemand(spec({ budget: { flexible: true } }));
    expect(noBudget.targetPriceMinor).toBeNull();
    expect(noBudget.maxBudgetMinor).toBeNull();
    expect(noBudget.currency).toBe("USD");

    const targetOnly = projectMissionDemand(
      spec({ budget: { target: { amount: 5000, currency: "EUR" }, flexible: false } }),
    );
    expect(targetOnly.currency).toBe("EUR");
    expect(targetOnly.maxBudgetMinor).toBeNull();
  });

  it("scales urgency: immediate outranks flexible", () => {
    expect(projectMissionDemand(spec({ timing: { urgency: "immediate" } })).urgencyScore).toBe(1);
    expect(projectMissionDemand(spec({ timing: { urgency: "flexible" } })).urgencyScore).toBe(0.2);
  });
});
