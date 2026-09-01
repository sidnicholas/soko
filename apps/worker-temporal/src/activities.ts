import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
  type NormalizedSupply,
} from "@opportunity-os/connectors-sdk";
import { scoreOpportunity, computeEconomics } from "@opportunity-os/scoring";
import { assessRisk } from "@opportunity-os/risk";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-temporal:activities");

const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

export interface DiscoveryInput {
  missionId: string;
  query: string;
  category?: string;
  expectedRevenueUsd: number;
}

export interface ScoredOpportunity {
  externalRef: string;
  title: string;
  overallScore: number;
  expectedNetProfitUsd: number;
  fraudRisk: number;
  complianceRisk: number;
}

/** §11.1(3) schedule connectors + §11.1(4) normalize supply candidates. */
export async function searchSupply(input: DiscoveryInput): Promise<NormalizedSupply[]> {
  const observations = await Promise.all(
    registry.withCapability("supply").map((c) => c.search({ query: input.query, category: input.category, max: 25, filters: {} })),
  );
  return observations
    .flat()
    .map(normalizeObservation)
    .filter((n): n is NormalizedSupply => n.kind === "supply");
}

/** §11.1(5-7) match/score/risk-check into ranked opportunities. */
export async function buildOpportunities(input: DiscoveryInput, supply: NormalizedSupply[]): Promise<ScoredOpportunity[]> {
  const seenHashes: string[] = [];
  const out: ScoredOpportunity[] = [];
  for (const s of supply) {
    const cost = s.price?.amount ?? 0;
    const econ = computeEconomics({
      expectedRevenueUsd: input.expectedRevenueUsd,
      expectedDirectCostUsd: cost / 100,
      capitalRequiredUsd: cost / 100,
    });
    const risk = assessRisk({ contentHash: s.content_hash, seenHashes }, s.category);
    seenHashes.push(s.content_hash);
    const score = scoreOpportunity({
      expected_net_profit_usd: econ.expectedNetProfitUsd,
      gross_margin_pct: econ.grossMarginPct,
      capital_required_usd: econ.capitalRequiredUsd,
      expected_minutes_human: 5,
      expected_minutes_elapsed: 60,
      close_probability: 0.6,
      buyer_intent: 0.7,
      urgency: 0.5,
      payment_certainty: 0.8,
      supply_confidence: s.source_reliability,
      repeatability: 0.4,
      customer_value: 0.5,
      fraud_risk: risk.fraud_risk,
      compliance_risk: risk.compliance_risk,
      operational_friction: 0.3,
      source_reliability: s.source_reliability,
    });
    out.push({
      externalRef: s.external_ref,
      title: s.title,
      overallScore: score.overall,
      expectedNetProfitUsd: econ.expectedNetProfitUsd,
      fraudRisk: risk.fraud_risk,
      complianceRisk: risk.compliance_risk,
    });
  }
  return out.sort((a, b) => b.overallScore - a.overallScore);
}

/** §11.1(8-9) persist + notify. Persistence is best-effort in dev; logs the pipeline result. */
export async function persistOpportunities(missionId: string, opportunities: ScoredOpportunity[]): Promise<number> {
  log.info({ missionId, count: opportunities.length, top: opportunities[0]?.overallScore }, "opportunities.persisted");
  return opportunities.length;
}
