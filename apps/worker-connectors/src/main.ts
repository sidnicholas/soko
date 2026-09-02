import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  normalizeObservation,
  type NormalizedSupply,
} from "@opportunity-os/connectors-sdk";
import { upsertSupply } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { ingestConnectors } from "./ingest";

const log = createLogger("worker-connectors");

const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

/** Persist a gated supply observation; demand-side is left to the discovery workflow. */
async function persist(supplyCount: { n: number }, normalized: NormalizedSupply): Promise<void> {
  await upsertSupply({
    sourceId: normalized.source_id,
    externalRef: normalized.external_ref,
    title: normalized.title,
    description: normalized.description,
    category: normalized.category,
    priceMinor: normalized.price?.amount ?? null,
    currency: normalized.price?.currency ?? "USD",
    quantity: normalized.quantity,
    sourceReliability: normalized.source_reliability,
  });
  supplyCount.n++;
}

async function main(): Promise<void> {
  const intervalMs = getConfig().policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ connectors: registry.all().map((c) => c.id), intervalMs }, "connector worker started");
  while (running) {
    const supplyCount = { n: 0 };
    const stats = await ingestConnectors(registry.all(), "", async (obs) => {
      const normalized = normalizeObservation(obs);
      if (normalized.kind === "supply") await persist(supplyCount, normalized);
    });
    log.info({ ...stats, supplyPersisted: supplyCount.n }, "ingest.cycle.complete");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "connector worker crashed");
  process.exitCode = 1;
});
