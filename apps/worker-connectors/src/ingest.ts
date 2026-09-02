import type { RawObservation } from "@opportunity-os/contracts";
import type { SourceConnector } from "@opportunity-os/connectors-sdk";
import { isAutomationPermitted } from "@opportunity-os/connectors-sdk";
import { isTransactableInV1, detectInjection } from "@opportunity-os/risk";

export interface IngestStats {
  fetched: number;
  kept: number;
  skippedConnectors: number;
  droppedCategory: number;
  droppedInjection: number;
}

export type ObservationSink = (obs: RawObservation) => Promise<void>;

function textOf(content: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["title", "description"]) {
    const value = content[key];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ");
}

function categoryOf(content: Record<string, unknown>): string | null {
  const category = content["category"];
  return typeof category === "string" ? category : null;
}

/**
 * §13/§17 risk-gated ingestion: skip connectors whose automation is not
 * permitted for unattended use (never prohibited scraping); drop observations
 * in non-transactable categories or carrying prompt-injection (untrusted data
 * as instructions); hand the rest to the sink.
 */
export async function ingestConnectors(
  connectors: readonly SourceConnector[],
  query: string,
  sink: ObservationSink,
): Promise<IngestStats> {
  const stats: IngestStats = { fetched: 0, kept: 0, skippedConnectors: 0, droppedCategory: 0, droppedInjection: 0 };
  for (const connector of connectors) {
    if (!isAutomationPermitted(connector.policy)) {
      stats.skippedConnectors++;
      continue;
    }
    const observations = await connector.search({ query, max: 25, filters: {} });
    for (const obs of observations) {
      stats.fetched++;
      if (!isTransactableInV1(categoryOf(obs.content))) {
        stats.droppedCategory++;
        continue;
      }
      if (detectInjection(textOf(obs.content)).length > 0) {
        stats.droppedInjection++;
        continue;
      }
      await sink(obs);
      stats.kept++;
    }
  }
  return stats;
}
