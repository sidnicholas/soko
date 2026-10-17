import type { RawObservation } from "@opportunity-os/contracts";
import {
  apifyClient,
  canonicalListingKey,
  ConnectorRegistry,
  FixtureDemandConnector,
  FixtureSupplyConnector,
  makeEbayConnector,
  makeReverbConnector,
  normalizeObservation,
  type NormalizedSupply,
  type SourceConnector,
} from "@opportunity-os/connectors-sdk";
import { closeDb, getConnectorSource, listActiveMissionsForDiscovery, recordSourceOutcome, recordSourceRuns, upsertSupply, type SourceRunRecord } from "@opportunity-os/db";
import { apifyCycle, checkDeals, healthFor, policyGaps, storeObservation, type CompsProvider } from "@opportunity-os/intel";
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
    listingUrl: normalized.uri,
    seller: normalized.seller,
    location: normalized.location,
    condition: normalized.condition,
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

/**
 * Apify actors (ADR-042): finish runs that ended (the webhook's fallback),
 * then start those due. Off without APIFY_API_TOKEN.
 */
async function apify(): Promise<unknown> {
  const { token, webhookSecret, dailyBudgetUsd } = config.connectors.apify;
  if (!token) return "not_configured";
  const base = config.notifications.publicApiBaseUrl;
  return apifyCycle({
    client: apifyClient({ token }),
    webhook: base && webhookSecret ? { url: `${base.replace(/\/$/, "")}/v1/webhooks/apify`, secret: webhookSecret } : null,
    dailyBudgetUsd,
  });
}

/**
 * Good-deal filter (ADR-044): prices new actor listings against active eBay
 * listings and raises supply leads for the ones well under market. Needs the
 * eBay credentials; without them listings stay unchecked.
 */
async function deals(): Promise<unknown> {
  const { ebayClientId, ebayClientSecret, ebayMarketplaceId, deals: cfg } = config.connectors;
  if (!ebayClientId || !ebayClientSecret) return "no_ebay_credentials";
  const ebay = makeEbayConnector({ clientId: ebayClientId, clientSecret: ebayClientSecret, marketplaceId: ebayMarketplaceId });
  const comps: CompsProvider = async (query) =>
    (await ebay.search({ query, max: 25, filters: {} }))
      .map((o) => ({ title: String(o.content["title"] ?? ""), url: o.ref.uri ?? null, priceMinor: typeof o.content["price"] === "number" ? o.content["price"] : 0, currency: String(o.content["currency"] ?? "USD") }))
      .filter((c) => c.priceMinor > 0);
  return checkDeals({ comps, limit: cfg.checksPerRun, leadLimit: cfg.leadsPerRun, minDiscount: cfg.minDiscount });
}

async function cycle(): Promise<void> {
  const supplyCount = { n: 0 };
  const sink: ObservationSink = async (obs: RawObservation) => {
    const normalized = normalizeObservation(obs);
    if (normalized.kind === "supply") await persist(supplyCount, normalized);
  };
  /** A registered connector's sink: through the observation ledger, so the same listing from an Apify actor merges into it. */
  const ledgerSink = (registryId: string): ObservationSink => async (obs: RawObservation) => {
    if (obs.kind !== "supply") return;
    await storeObservation(registryId, obs, canonicalListingKey(obs.ref.uri), null);
    supplyCount.n++;
  };
  const fixtures = await ingestConnectors(registry.all(), "", sink);
  const queries = queryConnectors.length > 0 ? searchQueries(await listActiveMissionsForDiscovery(), config.connectors.seedQuery) : [];
  const sources: Record<string, unknown> = {};
  for (const connector of queryConnectors) {
    // The source registry decides whether a connector runs (PRD v2 FR-01):
    // a paused row, or one whose terms review has lapsed, stops it.
    const entry = await getConnectorSource(connector.id);
    const blocked = !entry ? "not_registered" : entry.status !== "active" ? `status_${entry.status}` : (policyGaps(entry)[0] ?? null);
    if (blocked) {
      sources[connector.id] = { skipped: blocked };
      log.warn({ connector: connector.id, reason: blocked }, "ingest.connector.skipped_by_registry");
      continue;
    }
    // Sequential, to stay well inside each source's rate limits.
    const results = [];
    const runs: SourceRunRecord[] = [];
    for (const q of queries) {
      const outcome = await ingestOne(connector, q, ledgerSink(entry!.id));
      results.push({ q, ...outcome });
      const failed = "error" in outcome;
      runs.push({ sourceId: entry!.id, intelRunId: null, query: q, results: failed ? 0 : outcome.fetched, newResults: failed ? 0 : outcome.kept, leads: 0, costUsd: 0, error: failed ? outcome.error.slice(0, 500) : null });
      await recordSourceOutcome(entry!.id, !failed, healthFor);
    }
    await recordSourceRuns(runs);
    sources[connector.id] = results;
  }
  let apifyResult: unknown;
  try {
    apifyResult = await apify();
  } catch (err) {
    apifyResult = { error: String(err) };
    log.error({ err: String(err) }, "ingest.apify.failed");
  }
  let dealResult: unknown;
  try {
    dealResult = await deals();
  } catch (err) {
    dealResult = { error: String(err) };
    log.error({ err: String(err) }, "ingest.deals.failed");
  }
  log.info({ fixtures, queries, sources, apify: apifyResult, deals: dealResult, supplyPersisted: supplyCount.n }, "ingest.cycle.complete");
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
