import { createHash } from "node:crypto";
import type {
  ConnectorPolicy,
  ConnectorSearch,
  ExternalRef,
  RawObservation,
  VerificationResult,
} from "@opportunity-os/contracts";
import type { SourceConnector } from "./index";

const CAPTURED_AT = "2026-08-31T00:00:00.000Z";

function obs(kind: "supply" | "demand", sourceId: string, externalId: string, content: Record<string, unknown>): RawObservation {
  return {
    ref: { source_id: sourceId, external_id: externalId },
    kind,
    captured_at: CAPTURED_AT,
    content,
    content_hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    source_reliability: 0.6,
    automation: "manual_human_assisted",
  };
}

const SUPPLY_DATA: readonly RawObservation[] = [
  obs("supply", "fixture-supply", "sup-1001", {
    title: "Refurbished 27in 4K monitor",
    description: "Grade A refurbished 27-inch 4K IPS monitor, 12mo warranty.",
    category: "electronics",
    price: 18900,
    currency: "USD",
    quantity: 4,
  }),
  obs("supply", "fixture-supply", "sup-1002", {
    title: "Pallet of stackable dining chairs (24)",
    description: "Commercial-grade stackable chairs, light scuffs, local pickup.",
    category: "furniture",
    price: 42000,
    currency: "USD",
    quantity: 1,
  }),
  obs("supply", "fixture-supply", "sup-1003", {
    title: "Bulk USB-C cables (500)",
    description: "New 1m USB-C to USB-C 100W cables, boxed lot of 500.",
    category: "electronics",
    price: 95000,
    currency: "USD",
    quantity: 1,
  }),
];

const DEMAND_DATA: readonly RawObservation[] = [
  obs("demand", "fixture-demand", "dem-2001", {
    description: "Need a 27-inch 4K monitor under $220, delivered this week.",
    category: "electronics",
    target_price: 22000,
    currency: "USD",
  }),
  obs("demand", "fixture-demand", "dem-2002", {
    description: "Looking for ~20 stackable event chairs for a weekend rental.",
    category: "furniture",
    target_price: 50000,
    currency: "USD",
  }),
];

function matches(observation: RawObservation, input: ConnectorSearch): boolean {
  if (input.category && observation.content["category"] !== input.category) return false;
  const q = input.query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystack = `${observation.content["title"] ?? ""} ${observation.content["description"] ?? ""}`.toLowerCase();
  return q.split(/\s+/).some((term) => haystack.includes(term));
}

function makeFixtureConnector(
  id: string,
  data: readonly RawObservation[],
  policy: ConnectorPolicy,
  capabilities: SourceConnector["capabilities"],
): SourceConnector {
  return {
    id,
    capabilities,
    policy,
    async search(input) {
      return data.filter((d) => matches(d, input)).slice(0, input.max);
    },
    async fetch(ref: ExternalRef) {
      const found = data.find((d) => d.ref.external_id === ref.external_id);
      if (!found) throw new Error(`unknown ref: ${ref.external_id}`);
      return found;
    },
    async verify(ref: ExternalRef): Promise<VerificationResult> {
      const found = data.find((d) => d.ref.external_id === ref.external_id);
      return { ref, still_available: Boolean(found), verified_at: CAPTURED_AT };
    },
  };
}

const FIXTURE_POLICY: ConnectorPolicy = {
  automation: "manual_human_assisted",
  respects_robots: true,
  allowed_categories: ["electronics", "furniture"],
  notes: "Deterministic fixture source for development and golden-path tests (§28.10).",
};

/** §3.1(4)/§28(10) — two permitted fixture adapters: one supply, one demand. */
export const FixtureSupplyConnector: SourceConnector = makeFixtureConnector(
  "fixture-supply",
  SUPPLY_DATA,
  FIXTURE_POLICY,
  ["supply", "pricing", "availability"],
);

export const FixtureDemandConnector: SourceConnector = makeFixtureConnector(
  "fixture-demand",
  DEMAND_DATA,
  FIXTURE_POLICY,
  ["demand"],
);
