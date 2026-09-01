/**
 * §12 Opportunity Scoring V1.
 *
 * The final ranking function is deterministic and versioned CODE. An LLM may
 * estimate individual components, but the formula that combines them lives
 * here so scores are reproducible and auditable. A tiny, zero-capital,
 * near-certain, no-human-time opportunity can outrank a large one that needs
 * capital and hours of work (§12 worked example, enforced by unit test).
 */
export const SCORE_VERSION = "v1";

/** Normalized component scores. Ratio fields are 0..1; risk fields: higher = worse. */
export interface ScoreComponents {
  expected_net_profit_usd: number;
  gross_margin_pct: number;
  capital_required_usd: number;
  expected_minutes_human: number;
  expected_minutes_elapsed: number;
  close_probability: number;
  buyer_intent: number;
  urgency: number;
  payment_certainty: number;
  supply_confidence: number;
  repeatability: number;
  customer_value: number;
  fraud_risk: number;
  compliance_risk: number;
  operational_friction: number;
  source_reliability: number;
}

export interface EconomicsInput {
  expectedRevenueUsd: number;
  expectedDirectCostUsd: number;
  capitalRequiredUsd: number;
}

export interface Economics {
  expectedNetProfitUsd: number;
  grossMarginPct: number;
  capitalRequiredUsd: number;
}

export function computeEconomics(input: EconomicsInput): Economics {
  const profit = input.expectedRevenueUsd - input.expectedDirectCostUsd;
  const margin = input.expectedRevenueUsd > 0 ? profit / input.expectedRevenueUsd : 0;
  return {
    expectedNetProfitUsd: profit,
    grossMarginPct: clamp01(margin),
    capitalRequiredUsd: input.capitalRequiredUsd,
  };
}

/** Reward/penalty weights. Positive weights sum to 1.0; penalties are subtracted. */
const REWARD = {
  profit: 0.35,
  certainty: 0.3,
  buyerIntent: 0.1,
  repeatability: 0.08,
  customerValue: 0.07,
  urgency: 0.05,
  sourceReliability: 0.05,
} as const;

const PENALTY = {
  capital: 0.25,
  humanTime: 0.2,
  fraud: 0.3,
  compliance: 0.3,
  friction: 0.1,
} as const;

/** Half-saturation constants for diminishing-returns curves (USD / minutes). */
const PROFIT_HALF_USD = 50;
const CAPITAL_HALF_USD = 100;
const HUMAN_HALF_MIN = 30;

export interface ScoreBreakdown {
  reward: number;
  penalty: number;
  overall: number;
  version: string;
}

export function scoreOpportunity(c: ScoreComponents): ScoreBreakdown {
  const certainty = clamp01(c.close_probability) * clamp01(c.payment_certainty) * clamp01(c.supply_confidence);

  const reward =
    REWARD.profit * saturate(Math.max(0, c.expected_net_profit_usd), PROFIT_HALF_USD) +
    REWARD.certainty * certainty +
    REWARD.buyerIntent * clamp01(c.buyer_intent) +
    REWARD.repeatability * clamp01(c.repeatability) +
    REWARD.customerValue * clamp01(c.customer_value) +
    REWARD.urgency * clamp01(c.urgency) +
    REWARD.sourceReliability * clamp01(c.source_reliability);

  const penalty =
    PENALTY.capital * saturate(Math.max(0, c.capital_required_usd), CAPITAL_HALF_USD) +
    PENALTY.humanTime * saturate(Math.max(0, c.expected_minutes_human), HUMAN_HALF_MIN) +
    PENALTY.fraud * clamp01(c.fraud_risk) +
    PENALTY.compliance * clamp01(c.compliance_risk) +
    PENALTY.friction * clamp01(c.operational_friction);

  return { reward, penalty, overall: clamp01(reward - penalty), version: SCORE_VERSION };
}

export function rankScore(c: ScoreComponents): number {
  return scoreOpportunity(c).overall;
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Diminishing-returns curve: value/(value+half) in [0,1); == 0.5 at value=half. */
function saturate(value: number, half: number): number {
  if (value <= 0) return 0;
  return value / (value + half);
}
