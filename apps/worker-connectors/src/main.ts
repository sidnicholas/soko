import type { RawObservation } from "@opportunity-os/contracts";
import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  makeEbayConnector,
  normalizeObservation,
  type NormalizedSupply,
} from "@opportunity-os/connectors-sdk";
import { upsertSupply } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { ingestConnectors, type ObservationSink } from "./ingest";

const log = createLogger("worker-connectors");

const config = getConfig();
const registry = new ConnectorRegistry();
registry.register(FixtureSupplyConnector);
registry.register(FixtureDemandConnector);

// First real (non-fixture) source, §17/ADR-014 official_api. Absent
// credentials = fixtures only, same keyless-dev pattern as Stripe/Circle.
// Kept out of the registry's blank-query sweep below: unlike the fixture
// connectors (which return their whole static dataset on an empty query),
// eBay's Browse API requires a real search term.
const ebayConnector =
  config.connectors.ebayClientId && config.connectors.ebayClientSecret
    ? makeEbayConnector({
        clientId: config.connectors.ebayClientId,
        clientSecret: config.connectors.ebayClientSecret,
        marketplaceId: config.connectors.ebayMarketplaceId,
      })
    : undefined;

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

  const connectors = ebayConnector ? [...registry.all(), ebayConnector] : registry.all();
  log.info({ connectors: connectors.map((c) => c.id), intervalMs }, "connector worker started");
  const sink =
    (supplyCount: { n: number }): ObservationSink =>
    async (obs: RawObservation) => {
      const normalized = normalizeObservation(obs);
      if (normalized.kind === "supply") await persist(supplyCount, normalized);
    };
  while (running) {
    const supplyCount = { n: 0 };
    const stats = await ingestConnectors(registry.all(), "", sink(supplyCount));
    // Separate call, non-blank seed query — see ebayConnector's comment above.
    const ebayStats = ebayConnector ? await ingestConnectors([ebayConnector], config.connectors.ebaySeedQuery, sink(supplyCount)) : undefined;
    log.info({ ...stats, ebay: ebayStats, supplyPersisted: supplyCount.n }, "ingest.cycle.complete");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "connector worker crashed");
  process.exitCode = 1;
});
