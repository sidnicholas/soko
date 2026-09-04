import { createHash } from "node:crypto";
import type { AssetDescriptor } from "@opportunity-os/contracts";
import type {
  ApprovedAssetTransfer,
  AssetTransferCapabilities,
  AssetTransferRail,
  AssetTransferResult,
  AssetTransferStatusResult,
  PreparedAssetTransfer,
} from "@opportunity-os/settlement";

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type HoldingStatus = "PREPARED" | "HELD" | "DISPUTED" | "FROZEN" | "RECLAIMED";

interface Holding {
  reference: string;
  asset: AssetDescriptor;
  owner: string | null;
  status: HoldingStatus;
  events: AssetTransferEvent[];
}

export interface AssetTransferEvent {
  reference: string;
  type: "prepared" | "transferred" | "disputed" | "frozen" | "reclaimed";
  at: string;
  data?: Record<string, unknown>;
}

/**
 * §19.3 companion to `ProgrammableSettlementAdapter` — local/testnet
 * reference implementation of non-fungible/position transfer (NFT, DeFi
 * position, data-feed subscription, synthetic position). Tracks a single
 * current owner per reference rather than a Money balance; a real on-chain
 * integration needs a dedicated security audit before this holds anything of
 * value (§19.3, §29).
 */
export class ProgrammableAssetTransferAdapter implements AssetTransferRail {
  readonly railId = "onchain-asset-programmable";
  private readonly holdings: Record<string, Holding> = {};
  private readonly listeners: ((e: AssetTransferEvent) => void)[] = [];

  constructor(private readonly network: string = "local") {}

  onEvent(listener: (e: AssetTransferEvent) => void): void {
    this.listeners.push(listener);
  }

  capabilities(): AssetTransferCapabilities {
    return {
      assetKinds: ["nft", "defi_position", "data_feed_subscription", "synthetic_position"],
      supportsOwnershipProof: true,
      supportsReclaim: true,
    };
  }

  async prepare(asset: AssetDescriptor): Promise<PreparedAssetTransfer> {
    const reference = `${this.network}:${asset.kind}:${asset.locator}`;
    const holding: Holding = { reference, asset, owner: null, status: "PREPARED", events: [] };
    this.holdings[reference] = holding;
    this.record(holding, { reference, type: "prepared", at: now() });
    return { railId: this.railId, reference };
  }

  async execute(approved: ApprovedAssetTransfer): Promise<AssetTransferResult> {
    const h = this.require(approved.reference);
    if (h.status === "FROZEN" || h.status === "DISPUTED") {
      return { railId: this.railId, externalRef: approved.reference, status: "failed" };
    }
    h.owner = approved.toAddress;
    h.status = "HELD";
    const externalRef = `0x${canonicalHash({ ref: approved.reference, token: approved.approvalTokenHash }).slice(0, 40)}`;
    this.record(h, { reference: approved.reference, type: "transferred", at: now(), data: { to: approved.toAddress, externalRef } });
    return { railId: this.railId, externalRef, status: "confirmed" };
  }

  async status(ref: string): Promise<AssetTransferStatusResult> {
    const h = this.holdings[ref];
    if (!h) return { status: "failed" };
    if (h.status === "HELD") return { status: "confirmed", externalRef: ref };
    if (h.status === "RECLAIMED") return { status: "reclaimed", externalRef: ref };
    return { status: "pending", externalRef: ref };
  }

  async verifyOwnership(asset: AssetDescriptor, ownerAddress: string): Promise<boolean> {
    const reference = `${this.network}:${asset.kind}:${asset.locator}`;
    return this.holdings[reference]?.owner === ownerAddress;
  }

  async dispute(reference: string): Promise<void> {
    const h = this.require(reference);
    h.status = "DISPUTED";
    this.record(h, { reference, type: "disputed", at: now() });
  }

  async freeze(reference: string): Promise<void> {
    const h = this.require(reference);
    h.status = "FROZEN";
    this.record(h, { reference, type: "frozen", at: now() });
  }

  async reclaim(ref: string): Promise<AssetTransferResult> {
    const h = this.require(ref);
    h.owner = null;
    h.status = "RECLAIMED";
    this.record(h, { reference: ref, type: "reclaimed", at: now() });
    return { railId: this.railId, externalRef: `reclaim:${ref}`, status: "confirmed" };
  }

  events(reference: string): readonly AssetTransferEvent[] {
    return this.holdings[reference]?.events ?? [];
  }

  private record(h: Holding, event: AssetTransferEvent): void {
    h.events.push(event);
    for (const l of this.listeners) l(event);
  }

  private require(reference: string): Holding {
    const h = this.holdings[reference];
    if (!h) throw new Error(`unknown asset holding: ${reference}`);
    return h;
  }
}

function now(): string {
  return new Date().toISOString();
}
