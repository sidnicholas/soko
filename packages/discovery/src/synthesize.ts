import { listAvailableSupply, listOpenDemands } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { scoreAndPersistOpportunity } from "./score";

const log = createLogger("discovery:synthesize");

function readMinor(value: unknown): number | null {
  if (value && typeof value === "object" && "amount" in value && typeof value.amount === "number") return value.amount;
  return null;
}

function readCurrency(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "currency" in value && typeof value.currency === "string") return value.currency;
  return fallback;
}

export interface SynthesisResult {
  demandsProcessed: number;
  opportunitiesPersisted: number;
  topScore: number;
}

/**
 * Cross-source synthesis: match every open demand against all available supply,
 * regardless of source, so opportunities arise from independent signals with no
 * marketplace listing (buyer wants X, supplier has X → opportunity). Idempotent
 * via the (demand_id, supply_id) match key.
 */
export async function synthesizeOpportunities(
  opts: { demandLimit?: number; supplyLimit?: number } = {},
): Promise<SynthesisResult> {
  const demands = await listOpenDemands(opts.demandLimit ?? 100);
  const supply = await listAvailableSupply(opts.supplyLimit ?? 500);

  let opportunitiesPersisted = 0;
  let topScore = 0;

  for (const d of demands) {
    const demandCurrency = readCurrency(d.max_budget, readCurrency(d.target_price, d.currency));
    const seenHashes: string[] = [];
    for (const s of supply) {
      // Category pre-filter (the matcher gates too); skip obvious cross-category pairs.
      if (d.category && s.category && d.category !== s.category) continue;
      const result = await scoreAndPersistOpportunity(
        d.id,
        {
          description: d.description,
          category: d.category,
          targetPriceMinor: readMinor(d.target_price),
          maxBudgetMinor: readMinor(d.max_budget),
          currency: demandCurrency,
          urgencyScore: d.urgency_score,
        },
        s.id,
        {
          title: s.title,
          description: s.description,
          category: s.category,
          priceMinor: readMinor(s.price),
          currency: readCurrency(s.price, s.currency),
          contentHash: s.id,
          sourceReliability: 0.6,
        },
        seenHashes,
      );
      if (result.persisted) {
        opportunitiesPersisted++;
        if (result.overall > topScore) topScore = result.overall;
      }
    }
  }

  const result: SynthesisResult = { demandsProcessed: demands.length, opportunitiesPersisted, topScore };
  log.info(result, "discovery.synthesis.complete");
  return result;
}
