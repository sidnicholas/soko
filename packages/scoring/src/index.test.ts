import { describe, it, expect } from "vitest";
import { scoreOpportunity, rankScore, computeEconomics, SCORE_VERSION, type ScoreComponents } from "./index";

const base: ScoreComponents = {
  expected_net_profit_usd: 0,
  gross_margin_pct: 0,
  capital_required_usd: 0,
  expected_minutes_human: 0,
  expected_minutes_elapsed: 0,
  close_probability: 0.5,
  buyer_intent: 0.5,
  urgency: 0.5,
  payment_certainty: 0.5,
  supply_confidence: 0.5,
  repeatability: 0.5,
  customer_value: 0.5,
  fraud_risk: 0.1,
  compliance_risk: 0.1,
  operational_friction: 0.1,
  source_reliability: 0.5,
};

describe("opportunity scoring v1", () => {
  it("ranks a tiny zero-capital near-certain opportunity above a large capital-heavy one (§12)", () => {
    const small: ScoreComponents = {
      ...base,
      expected_net_profit_usd: 5,
      capital_required_usd: 0,
      expected_minutes_human: 0,
      close_probability: 0.95,
      payment_certainty: 0.95,
      supply_confidence: 0.9,
      buyer_intent: 0.8,
      fraud_risk: 0.05,
      compliance_risk: 0.05,
      operational_friction: 0.05,
      source_reliability: 0.8,
    };
    const big: ScoreComponents = {
      ...base,
      expected_net_profit_usd: 500,
      capital_required_usd: 500,
      expected_minutes_human: 120,
      close_probability: 0.5,
      payment_certainty: 0.6,
      supply_confidence: 0.7,
      buyer_intent: 0.6,
      fraud_risk: 0.2,
      compliance_risk: 0.2,
      operational_friction: 0.5,
      source_reliability: 0.6,
    };
    expect(rankScore(small)).toBeGreaterThan(rankScore(big));
  });

  it("is deterministic and bounded to [0,1]", () => {
    const a = scoreOpportunity(base);
    const b = scoreOpportunity(base);
    expect(a.overall).toBe(b.overall);
    expect(a.overall).toBeGreaterThanOrEqual(0);
    expect(a.overall).toBeLessThanOrEqual(1);
    expect(a.version).toBe(SCORE_VERSION);
  });

  it("computes economics from revenue and cost", () => {
    expect(computeEconomics({ expectedRevenueUsd: 100, expectedDirectCostUsd: 60, capitalRequiredUsd: 0 })).toEqual({
      expectedNetProfitUsd: 40,
      grossMarginPct: 0.4,
      capitalRequiredUsd: 0,
    });
  });
});
