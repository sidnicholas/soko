import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
} from "@opportunity-os/connectors-sdk";
import { upsertSupply } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-connectors");

const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

/**
 * One ingestion pass across all registered connectors (§9, §3.1(5)). Supply
 * observations are normalized and upserted idempotently (keyed on
 * source_id/external_ref) so continuous ingestion refreshes rows in place.
 * Demand-side observations are counted here; mission-driven demand is persisted
 * by the discovery workflow.
 */
async function ingest(query: string): Promise<{ supply: number; demand: number }> {
  let supply = 0;
  let demand = 0;
  for (const connector of registry.all()) {
    const observations = await connector.search({ query, max: 25, filters: {} });
    for (const obs of observations) {
      const n = normalizeObservation(obs);
      if (n.kind === "supply") {
        await upsertSupply({
          sourceId: n.source_id,
          externalRef: n.external_ref,
          title: n.title,
          description: n.description,
          category: n.category,
          priceMinor: n.price?.amount ?? null,
          currency: n.price?.currency ?? "USD",
          quantity: n.quantity,
          sourceReliability: n.source_reliability,
        });
        supply++;
      } else {
        demand++;
      }
    }
  }
  return { supply, demand };
}

async function main(): Promise<void> {
  const intervalMs = getConfig().policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ connectors: registry.all().map((c) => c.id), intervalMs }, "connector worker started");
  while (running) {
    const counts = await ingest("");
    log.info({ supply: counts.supply, demand: counts.demand }, "ingest.cycle.complete");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "connector worker crashed");
  process.exitCode = 1;
});
