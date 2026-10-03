import type { RawObservation } from "@opportunity-os/contracts";
import {
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  makeEbayConnector,
  makeReverbConnector,
  normalizeObservation,
  type NormalizedSupply,
  type SourceConnector,
} from "@opportunity-os/connectors-sdk";
import { closeDb, listActiveMissionsForDiscovery, upsertSupply } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { ingestConnectors, type IngestStats, type ObservationSink } from "./ingest";
import { searchQueries } from "./queries";

const log = createLogger("worker-connectors");

const config = getConfig();
const registry = new ConnectorRegistry();
// Static fake listings: dev/test only unless FIXTURE_CONNECTORS says otherwise.
if (config.connectors.fixtures) {
  registry.register(FixtureSupplyConnector);
  registry.register(FixtureDemandConnector);
}

/**
 * Real sources, §17/ADR-014 official APIs. Kept out of the registry's
 * blank-query sweep below: unlike the fixture connectors (which return their
 * whole static dataset on an empty query), marketplace search APIs require a
 * real search term, so they run once per active mission's demand instead.
 *
 * eBay: absent credentials = not used (keyless-dev pattern, as Stripe/Circle).
 * Reverb: listing search is public, so it is keyless but opt-in.
 */
const queryConnectors: SourceConnector[] = [];
if (config.connectors.ebayClientId && config.connectors.ebayClientSecret) {
  queryConnectors.push(
    makeEbayConnector({
      clientId: config.connectors.ebayClientId,
      clientSecret: config.connectors.ebayClientSecret,
      marketplaceId: config.connectors.ebayMarketplaceId,
    }),
  );
}
if (config.connectors.reverbEnabled) {
  queryConnectors.push(makeReverbConnector({ apiToken: config.connectors.reverbApiToken }));
}

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

/** One connector + query; a failing source (outage, rate limit) is logged and skipped, never fatal to the cycle. */
async function ingestOne(connector: SourceConnector, query: string, sink: ObservationSink): Promise<IngestStats | { error: string }> {
  try {
    return await ingestConnectors([connector], query, sink);
  } catch (err) {
    log.warn({ connector: connector.id, query, err: String(err) }, "ingest.connector.failed");
    return { error: String(err) };
  }
}

async function cycle(): Promise<void> {
  const supplyCount = { n: 0 };
  const sink: ObservationSink = async (obs: RawObservation) => {
    const normalized = normalizeObservation(obs);
    if (normalized.kind === "supply") await persist(supplyCount, normalized);
  };
  const fixtures = await ingestConnectors(registry.all(), "", sink);
  const queries = queryConnectors.length > 0 ? searchQueries(await listActiveMissionsForDiscovery(), config.connectors.seedQuery) : [];
  const sources: Record<string, unknown> = {};
  for (const connector of queryConnectors) {
    // Sequential, to stay well inside each source's rate limits.
    const results = [];
    for (const q of queries) results.push({ q, ...(await ingestOne(connector, q, sink)) });
    sources[connector.id] = results;
  }
  log.info({ fixtures, queries, sources, supplyPersisted: supplyCount.n }, "ingest.cycle.complete");
}

async function main(): Promise<void> {
  // `--once`: one cycle then exit (non-zero on failure), for a scheduled cron service.
  if (process.argv.includes("--once")) {
    let code = 0;
    try {
      await cycle();
    } catch (err) {
      log.error({ err: String(err) }, "ingest.cycle.failed");
      code = 1;
    }
    await closeDb();
    process.exit(code);
  }
  const intervalMs = config.policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ connectors: [...registry.all(), ...queryConnectors].map((c) => c.id), intervalMs }, "connector worker started");
  while (running) {
    try {
      await cycle();
    } catch (err) {
      // e.g. a database blip; retry next interval rather than exiting the worker.
      log.error({ err: String(err) }, "ingest.cycle.failed");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "connector worker crashed");
  process.exitCode = 1;
});
