import { createHash } from "node:crypto";
import type {
  ConnectorCapability,
  ConnectorPolicy,
  ConnectorSearch,
  ExternalRef,
  RawObservation,
  VerificationResult,
} from "@opportunity-os/contracts";

export * from "./fixtures";
export * from "./normalize";

/** §17 — every source adapter implements this interface. */
export interface SourceConnector {
  readonly id: string;
  readonly capabilities: readonly ConnectorCapability[];
  readonly policy: ConnectorPolicy;
  search(input: ConnectorSearch): Promise<RawObservation[]>;
  fetch(ref: ExternalRef): Promise<RawObservation>;
  verify?(ref: ExternalRef): Promise<VerificationResult>;
}

/** Stable content hash for evidence + dedupe (§13.2, §13.4). */
export function hashContent(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
}

/** In-process registry the connector worker scans to schedule ingestion (§9). */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, SourceConnector>();

  register(connector: SourceConnector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`connector already registered: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): SourceConnector | undefined {
    return this.connectors.get(id);
  }

  all(): SourceConnector[] {
    return [...this.connectors.values()];
  }

  withCapability(capability: ConnectorCapability): SourceConnector[] {
    return this.all().filter((c) => c.capabilities.includes(capability));
  }
}
