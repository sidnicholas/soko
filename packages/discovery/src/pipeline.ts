import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
  type NormalizedSupply,
} from "@opportunity-os/connectors-sdk";
import { isTransactableInV1 } from "@opportunity-os/risk";
import { upsertMissionDemand, upsertSupply } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { scoreAndPersistOpportunity } from "./score";

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
 * §11.1 one discovery cycle: ensure the mission demand, schedule connectors,
 * normalize + persist supply, then match/score/persist opportunities via the
 * shared scorer. Idempotent — safe on every scheduler sweep or workflow cadence.
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

  const seenHashes: string[] = [];
  let supplyPersisted = 0;
  let matchesPersisted = 0;
  let opportunitiesPersisted = 0;
  let topScore = 0;

  for (const s of supply) {
    // §13 compliance gate: never persist/score a prohibited category.
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

    const result = await scoreAndPersistOpportunity(
      demandId,
      input.demand,
      supplyId,
      {
        title: s.title,
        description: s.description,
        category: s.category,
        priceMinor: s.price?.amount ?? null,
        currency: s.price?.currency ?? input.demand.currency,
        contentHash: s.content_hash,
        sourceReliability: s.source_reliability,
      },
      seenHashes,
    );
    if (result.persisted) {
      matchesPersisted++;
      opportunitiesPersisted++;
      if (result.overall > topScore) topScore = result.overall;
    }
  }

  const result: DiscoveryResult = { demandId, supplyPersisted, matchesPersisted, opportunitiesPersisted, topScore };
  log.info(result, "discovery.cycle.persisted");
  return result;
}
