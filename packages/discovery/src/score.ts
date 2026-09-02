import {
  SCORE_VERSION,
  computeEconomics,
  matchDemandToSupply,
  scoreOpportunity,
  MATCH_MIN_TOTAL,
  clamp01,
} from "@opportunity-os/scoring";
import { assessRisk, isTransactableInV1 } from "@opportunity-os/risk";
import { upsertMatch, upsertOpportunity } from "@opportunity-os/db";

export interface ScorerDemand {
  description: string;
  category: string | null;
  targetPriceMinor: number | null;
  maxBudgetMinor: number | null;
  currency: string;
  urgencyScore: number;
}

export interface ScorerSupply {
  title: string;
  description: string;
  category: string | null;
  priceMinor: number | null;
  currency: string;
  /** Stable dedupe key for §13 anti-gaming (supply id or content hash). */
  contentHash: string;
  sourceReliability: number;
}

export interface ScoreAndPersistResult {
  persisted: boolean;
  overall: number;
}

/**
 * Match one demand against one supply, and — if it clears the threshold and the
 * §13 category gate — persist the match + a scored broker opportunity. Shared
 * by mission discovery and cross-source synthesis so the economics/score/persist
 * logic exists once. `seenHashes` is mutated for anti-gaming dedupe within a pass.
 */
export async function scoreAndPersistOpportunity(
  demandId: string,
  demand: ScorerDemand,
  supplyId: string,
  supply: ScorerSupply,
  seenHashes: string[],
): Promise<ScoreAndPersistResult> {
  if (supply.category && !isTransactableInV1(supply.category)) return { persisted: false, overall: 0 };

  const match = matchDemandToSupply(
    { description: demand.description, category: demand.category, targetPriceMinor: demand.targetPriceMinor, maxBudgetMinor: demand.maxBudgetMinor },
    { title: supply.title, description: supply.description, category: supply.category, priceMinor: supply.priceMinor },
  );
  if (match.total < MATCH_MIN_TOTAL) return { persisted: false, overall: 0 };

  const { matchId } = await upsertMatch({
    demandId,
    supplyId,
    semantic: match.semantic,
    constraint: match.constraint,
    geography: match.geography,
    timing: match.timing,
    quality: match.quality,
    total: match.total,
    explanation: match.explanation,
  });

  const costMinor = supply.priceMinor ?? 0;
  const grossRevenueMinor = demand.maxBudgetMinor ?? demand.targetPriceMinor ?? costMinor;
  const econ = computeEconomics({
    expectedRevenueUsd: grossRevenueMinor / 100,
    expectedDirectCostUsd: costMinor / 100,
    capitalRequiredUsd: 0, // broker role: no inventory ownership (§3)
  });
  const risk = assessRisk({ contentHash: supply.contentHash, seenHashes }, supply.category);
  seenHashes.push(supply.contentHash);

  const score = scoreOpportunity({
    expected_net_profit_usd: econ.expectedNetProfitUsd,
    gross_margin_pct: econ.grossMarginPct,
    capital_required_usd: econ.capitalRequiredUsd,
    expected_minutes_human: 5,
    expected_minutes_elapsed: 60,
    close_probability: clamp01(0.5 + 0.3 * match.total),
    buyer_intent: match.constraint,
    urgency: demand.urgencyScore,
    payment_certainty: 0.8,
    supply_confidence: supply.sourceReliability,
    repeatability: 0.4,
    customer_value: match.total,
    fraud_risk: risk.fraud_risk,
    compliance_risk: risk.compliance_risk,
    operational_friction: 0.3,
    source_reliability: supply.sourceReliability,
  });

  await upsertOpportunity({
    matchId,
    status: "qualified",
    transactionRole: "broker",
    expectedRevenueMinor: grossRevenueMinor,
    expectedDirectCostMinor: costMinor,
    expectedNetProfitMinor: Math.round(econ.expectedNetProfitUsd * 100),
    capitalRequiredMinor: 0,
    currency: supply.currency,
    closeProbability: clamp01(0.5 + 0.3 * match.total),
    timeToCashMinutes: 60,
    repeatabilityScore: 0.4,
    paymentCertaintyScore: 0.8,
    fraudRiskScore: risk.fraud_risk,
    complianceRiskScore: risk.compliance_risk,
    operationalFrictionScore: 0.3,
    customerValueScore: match.total,
    overallScore: score.overall,
    scoreVersion: SCORE_VERSION,
    nextAction: "operator_review",
  });

  return { persisted: true, overall: score.overall };
}
