import { createHash } from "node:crypto";
import type {
  AutomationMethod,
  ConnectorCapability,
  ConnectorPolicy,
  ConnectorSearch,
  ExternalRef,
  RawObservation,
} from "@opportunity-os/contracts";
import type { SourceConnector } from "./index";

/**
 * §17/ADR-014 — automations we may run unattended. Prohibited scraping never
 * qualifies. permitted_public_fetch only when robots.txt is respected.
 */
const PERMITTED_AUTOMATION: Record<AutomationMethod, boolean> = {
  official_api: true,
  licensed_feed: true,
  authorized_user_connection: true,
  permitted_public_fetch: true,
  manual_human_assisted: false,
};

export function isAutomationPermitted(policy: ConnectorPolicy): boolean {
  if (!PERMITTED_AUTOMATION[policy.automation]) return false;
  if (policy.automation === "permitted_public_fetch" && !policy.respects_robots) return false;
  return true;
}

/** A source item mapped out of an API/page response, before it becomes an observation. */
export interface MappedItem {
  kind: "supply" | "demand";
  externalId: string;
  uri?: string;
  content: Record<string, unknown>;
  sourceReliability?: number;
}

function toObservation(sourceId: string, automation: AutomationMethod, item: MappedItem): RawObservation {
  const contentHash = createHash("sha256").update(JSON.stringify(item.content), "utf8").digest("hex");
  return {
    ref: { source_id: sourceId, external_id: item.externalId, uri: item.uri },
    kind: item.kind,
    captured_at: new Date().toISOString(),
    content: item.content,
    content_hash: contentHash,
    source_reliability: item.sourceReliability ?? 0.7,
    automation,
  };
}

export interface HttpConnectorConfig {
  id: string;
  capabilities: readonly ConnectorCapability[];
  policy: ConnectorPolicy;
  /** Injected for tests / custom auth; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** May be async — e.g. an OAuth client-credentials token fetched/cached before the request is built. */
  buildRequest(input: ConnectorSearch): { url: string; init?: RequestInit } | Promise<{ url: string; init?: RequestInit }>;
}

/** Official-API / licensed-feed connector: fetch JSON, map to observations. */
export function makeHttpApiConnector(
  cfg: HttpConnectorConfig & { mapResponse(json: unknown, input: ConnectorSearch): MappedItem[] },
): SourceConnector {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    id: cfg.id,
    capabilities: cfg.capabilities,
    policy: cfg.policy,
    async search(input: ConnectorSearch): Promise<RawObservation[]> {
      const { url, init } = await cfg.buildRequest(input);
      const res = await doFetch(url, init);
      if (!res.ok) throw new Error(`${cfg.id} api ${res.status}`);
      const json: unknown = await res.json();
      return cfg.mapResponse(json, input).map((item) => toObservation(cfg.id, cfg.policy.automation, item));
    },
    async fetch(ref: ExternalRef): Promise<RawObservation> {
      const res = await doFetch(ref.uri ?? "", {});
      if (!res.ok) throw new Error(`${cfg.id} fetch ${res.status}`);
      const items = cfg.mapResponse(await res.json(), { query: "", max: 1, filters: {} });
      const item = items.find((i) => i.externalId === ref.external_id) ?? items[0];
      if (!item) throw new Error(`${cfg.id} fetch: no item for ${ref.external_id}`);
      return toObservation(cfg.id, cfg.policy.automation, item);
    },
  };
}

/** Permitted public-fetch (robots-respecting) connector: fetch text, parse to observations. */
export function makeCrawlConnector(
  cfg: HttpConnectorConfig & { parse(body: string, input: ConnectorSearch): MappedItem[] },
): SourceConnector {
  const doFetch = cfg.fetchImpl ?? fetch;
  return {
    id: cfg.id,
    capabilities: cfg.capabilities,
    policy: cfg.policy,
    async search(input: ConnectorSearch): Promise<RawObservation[]> {
      const { url, init } = await cfg.buildRequest(input);
      const res = await doFetch(url, init);
      if (!res.ok) throw new Error(`${cfg.id} crawl ${res.status}`);
      return cfg.parse(await res.text(), input).map((item) => toObservation(cfg.id, cfg.policy.automation, item));
    },
    async fetch(ref: ExternalRef): Promise<RawObservation> {
      const res = await doFetch(ref.uri ?? "", {});
      if (!res.ok) throw new Error(`${cfg.id} fetch ${res.status}`);
      const items = cfg.parse(await res.text(), { query: "", max: 1, filters: {} });
      const item = items.find((i) => i.externalId === ref.external_id) ?? items[0];
      if (!item) throw new Error(`${cfg.id} fetch: no item for ${ref.external_id}`);
      return toObservation(cfg.id, cfg.policy.automation, item);
    },
  };
}
