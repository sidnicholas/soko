import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
  type NormalizedSupply,
} from "@opportunity-os/connectors-sdk";
import {
  SCORE_VERSION,
  computeEconomics,
  matchDemandToSupply,
  scoreOpportunity,
  MATCH_MIN_TOTAL,
  clamp01,
} from "@opportunity-os/scoring";
import { assessRisk, isTransactableInV1 } from "@opportunity-os/risk";
import { upsertMissionDemand, upsertSupply, upsertMatch, upsertOpportunity } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("discovery:pipeline");

const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

/** The mission's demand_spec projected into matchable/persistable fields (§6.4, §7). */
export interface DiscoveryDemand {
  description: string;
  category: string | null;
  targetPriceMinor: number | null;
  maxBudgetMinor: number | null;
  currency: string;
  urgencyScore: number;
}

export interface DiscoveryInput {
  missionId: string;
  query: string;
  category?: string;
  demand: DiscoveryDemand;
}

export interface DiscoveryResult {
  demandId: string;
  supplyPersisted: number;
  matchesPersisted: number;
  opportunitiesPersisted: number;
  topScore: number;
}

/**
 * §11.1 one discovery cycle, fully persisted:
 * ensure mission demand -> schedule connectors -> normalize supply ->
 * persist supply -> match demand x supply -> economics/risk/score ->
 * persist qualified opportunities. Idempotent: re-running refreshes rows
 * in place (§11.1(3-9)) so it is safe to invoke on every scheduler sweep
 * (lifecycle worker) or Temporal workflow cadence.
 */
export async function runDiscoveryCycle(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { demandId } = await upsertMissionDemand({
    missionId: input.missionId,
    sourceId: "mission",
    description: input.demand.description,
    category: input.demand.category,
    targetPriceMinor: input.demand.targetPriceMinor,
    maxBudgetMinor: input.demand.maxBudgetMinor,
    currency: input.demand.currency,
    urgencyScore: input.demand.urgencyScore,
  });

  const observations = await Promise.all(
    registry
      .withCapability("supply")
      .map((c) => c.search({ query: input.query, category: input.category, max: 25, filters: {} })),
  );
  const supply = observations
    .flat()
    .map(normalizeObservation)
    .filter((n): n is NormalizedSupply => n.kind === "supply");

  const revenueMinor = input.demand.maxBudgetMinor ?? input.demand.targetPriceMinor;
  const seenHashes: string[] = [];
  let supplyPersisted = 0;
  let matchesPersisted = 0;
  let opportunitiesPersisted = 0;
  let topScore = 0;

  for (const s of supply) {
    // §13 compliance gate: never turn a prohibited category into an opportunity.
    if (s.category && !isTransactableInV1(s.category)) {
      log.debug({ ref: s.external_ref, category: s.category }, "supply.skipped.category_gate");
      continue;
    }

    const { supplyId } = await upsertSupply({
      sourceId: s.source_id,
      externalRef: s.external_ref,
      title: s.title,
      description: s.description,
      category: s.category,
      priceMinor: s.price?.amount ?? null,
      currency: s.price?.currency ?? input.demand.currency,
      quantity: s.quantity,
      sourceReliability: s.source_reliability,
    });
    supplyPersisted++;

    const match = matchDemandToSupply(
      {
        description: input.demand.description,
        category: input.demand.category,
        targetPriceMinor: input.demand.targetPriceMinor,
        maxBudgetMinor: input.demand.maxBudgetMinor,
      },
      {
        title: s.title,
        description: s.description,
        category: s.category,
        priceMinor: s.price?.amount ?? null,
      },
    );
    if (match.total < MATCH_MIN_TOTAL) continue;

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
    matchesPersisted++;

    const costMinor = s.price?.amount ?? 0;
    const grossRevenueMinor = revenueMinor ?? costMinor;
    const econ = computeEconomics({
      expectedRevenueUsd: grossRevenueMinor / 100,
      expectedDirectCostUsd: costMinor / 100,
      // Broker role: no inventory ownership, so no capital outlay (§3).
      capitalRequiredUsd: 0,
    });
    const risk = assessRisk({ contentHash: s.content_hash, seenHashes }, s.category);
    seenHashes.push(s.content_hash);

    const score = scoreOpportunity({
      expected_net_profit_usd: econ.expectedNetProfitUsd,
      gross_margin_pct: econ.grossMarginPct,
      capital_required_usd: econ.capitalRequiredUsd,
      expected_minutes_human: 5,
      expected_minutes_elapsed: 60,
      close_probability: clamp01(0.5 + 0.3 * match.total),
      buyer_intent: match.constraint,
      urgency: input.demand.urgencyScore,
      payment_certainty: 0.8,
      supply_confidence: s.source_reliability,
      repeatability: 0.4,
      customer_value: match.total,
      fraud_risk: risk.fraud_risk,
      compliance_risk: risk.compliance_risk,
      operational_friction: 0.3,
      source_reliability: s.source_reliability,
    });

    const netProfitMinor = Math.round(econ.expectedNetProfitUsd * 100);
    await upsertOpportunity({
      matchId,
      status: "qualified",
      transactionRole: "broker",
      expectedRevenueMinor: grossRevenueMinor,
      expectedDirectCostMinor: costMinor,
      expectedNetProfitMinor: netProfitMinor,
      capitalRequiredMinor: 0,
      currency: s.price?.currency ?? input.demand.currency,
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
    opportunitiesPersisted++;
    if (score.overall > topScore) topScore = score.overall;
  }

  const result: DiscoveryResult = {
    demandId,
    supplyPersisted,
    matchesPersisted,
    opportunitiesPersisted,
    topScore,
  };
  log.info(result, "discovery.cycle.persisted");
  return result;
}
