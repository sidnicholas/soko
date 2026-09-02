import { listArbitrageEdges, listBundleEntities, entityPriceStats, upsertGraphOpportunity } from "@opportunity-os/db";
import { SCORE_VERSION, computeEconomics, scoreOpportunity, clamp01 } from "@opportunity-os/scoring";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("discovery:deals");

function readMinor(meta: unknown, key: string): number | null {
  if (meta && typeof meta === "object" && key in meta) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function readStr(meta: unknown, key: string, fallback: string): string {
  if (meta && typeof meta === "object" && key in meta) {
    const value = (meta as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return fallback;
}

export interface GraphDealsResult {
  arbitrage: number;
  bundle: number;
}

/**
 * Turn market-graph edges into first-class deals on the operator feed:
 *  - ARBITRAGE (cross-entity): buy cheap, sell into a dearer substitute market.
 *  - BUNDLE_AVAILABLE: aggregate multiple sellers (savings = median - min).
 * Idempotent via dedupe_key. Runs each lifecycle sweep after buildGraphEdges.
 */
export async function opportunitiesFromGraph(): Promise<GraphDealsResult> {
  let arbitrage = 0;
  for (const e of await listArbitrageEdges()) {
    const buy = readMinor(e.meta, "buyMinor");
    const sell = readMinor(e.meta, "sellRefMinor");
    if (buy === null || sell === null || sell <= buy) continue;
    const currency = readStr(e.meta, "currency", "USD");
    const spread = Number(e.spread);
    const econ = computeEconomics({ expectedRevenueUsd: sell / 100, expectedDirectCostUsd: buy / 100, capitalRequiredUsd: 0 });
    const score = scoreOpportunity({
      expected_net_profit_usd: econ.expectedNetProfitUsd,
      gross_margin_pct: econ.grossMarginPct,
      capital_required_usd: 0,
      expected_minutes_human: 5,
      expected_minutes_elapsed: 60,
      close_probability: clamp01(0.4 + 0.4 * spread),
      buyer_intent: clamp01(spread),
      urgency: 0.5,
      payment_certainty: 0.7,
      supply_confidence: 0.6,
      repeatability: 0.4,
      customer_value: clamp01(spread),
      fraud_risk: 0.1,
      compliance_risk: 0,
      operational_friction: 0.3,
      source_reliability: 0.6,
    });
    await upsertGraphOpportunity({
      kind: "arbitrage",
      dedupeKey: `arb:${e.srcId}:${e.dstId}`,
      expectedRevenueMinor: sell,
      expectedDirectCostMinor: buy,
      expectedNetProfitMinor: sell - buy,
      currency,
      overallScore: score.overall,
      closeProbability: clamp01(0.4 + 0.4 * spread),
      customerValueScore: clamp01(spread),
      scoreVersion: SCORE_VERSION,
      nextAction: "operator_review",
      source: { buyEntity: e.srcId, sellEntity: e.dstId, srcTitle: e.srcTitle, dstTitle: e.dstTitle, buyMinor: buy, sellRefMinor: sell },
    });
    arbitrage++;
  }

  let bundle = 0;
  for (const b of await listBundleEntities()) {
    const stats = await entityPriceStats(b.entityId);
    if (!stats || stats.medianMinor <= stats.minMinor) continue;
    const savings = stats.medianMinor - stats.minMinor;
    const rel = stats.medianMinor > 0 ? savings / stats.medianMinor : 0;
    const econ = computeEconomics({ expectedRevenueUsd: stats.medianMinor / 100, expectedDirectCostUsd: stats.minMinor / 100, capitalRequiredUsd: 0 });
    const score = scoreOpportunity({
      expected_net_profit_usd: econ.expectedNetProfitUsd,
      gross_margin_pct: econ.grossMarginPct,
      capital_required_usd: 0,
      expected_minutes_human: 10,
      expected_minutes_elapsed: 120,
      close_probability: 0.5,
      buyer_intent: 0.4,
      urgency: 0.4,
      payment_certainty: 0.7,
      supply_confidence: 0.6,
      repeatability: 0.5,
      customer_value: clamp01(rel),
      fraud_risk: 0.1,
      compliance_risk: 0,
      operational_friction: 0.4,
      source_reliability: 0.6,
    });
    await upsertGraphOpportunity({
      kind: "bundle",
      dedupeKey: `bundle:${b.entityId}`,
      expectedRevenueMinor: stats.medianMinor,
      expectedDirectCostMinor: stats.minMinor,
      expectedNetProfitMinor: savings,
      currency: stats.currency,
      overallScore: score.overall,
      closeProbability: 0.5,
      customerValueScore: clamp01(rel),
      scoreVersion: SCORE_VERSION,
      nextAction: "operator_review",
      source: { entityId: b.entityId, title: b.title, sellerCount: Number(b.sellerCount) },
    });
    bundle++;
  }

  const result: GraphDealsResult = { arbitrage, bundle };
  log.info(result, "discovery.graph.deals");
  return result;
}
