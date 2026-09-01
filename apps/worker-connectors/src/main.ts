import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
} from "@opportunity-os/connectors-sdk";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-connectors");

const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

/** One ingestion pass across all registered connectors (§9, §3.1(5)). */
async function ingest(query: string): Promise<number> {
  let count = 0;
  for (const connector of registry.all()) {
    const observations = await connector.search({ query, max: 25, filters: {} });
    for (const obs of observations) {
      const normalized = normalizeObservation(obs);
      log.debug({ connector: connector.id, kind: normalized.kind, ref: normalized.external_ref }, "observation.normalized");
      count++;
    }
  }
  return count;
}

async function main(): Promise<void> {
  const intervalMs = getConfig().policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ connectors: registry.all().map((c) => c.id), intervalMs }, "connector worker started");
  while (running) {
    const n = await ingest("");
    log.info({ ingested: n }, "ingest.cycle.complete");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "connector worker crashed");
  process.exitCode = 1;
});
