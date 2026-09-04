import type { AssetDescriptor, AssetKind, AssetTransferStatus } from "@opportunity-os/contracts";

/**
 * §19 crypto-asset expansion — ownership/position transfer (NFT, DeFi
 * position, data-feed subscription, synthetic position) is a distinct
 * guarantee from currency settlement: it moves a specific object or position,
 * not a fungible amount, so it gets its own rail abstraction rather than an
 * extra `SettlementRail` method. Deliberately unopinionated about which
 * `AssetKind`s are actually enabled for trading — that's the risk category
 * gate (`@opportunity-os/risk` `CATEGORY_POLICY`), not this interface.
 */
export interface AssetTransferCapabilities {
  assetKinds: readonly AssetKind[];
  supportsOwnershipProof: boolean;
  /** Can a confirmed transfer be clawed back on dispute (escrow-held asset), or is it final once executed? */
  supportsReclaim: boolean;
}

export interface PreparedAssetTransfer {
  railId: string;
  reference: string;
}

/** An asset transfer that has already passed the policy/human gate (§13.5, mirrors ApprovedSettlement). */
export interface ApprovedAssetTransfer {
  railId: string;
  reference: string;
  approvalTokenHash: string;
  asset: AssetDescriptor;
  toAddress: string;
}

export interface AssetTransferResult {
  railId: string;
  externalRef: string;
  status: "pending" | "confirmed" | "failed";
}

export interface AssetTransferStatusResult {
  status: AssetTransferStatus;
  externalRef?: string;
}

export interface AssetTransferRail {
  readonly railId: string;
  capabilities(): AssetTransferCapabilities;
  prepare(asset: AssetDescriptor): Promise<PreparedAssetTransfer>;
  execute(approved: ApprovedAssetTransfer): Promise<AssetTransferResult>;
  status(ref: string): Promise<AssetTransferStatusResult>;
  /** Does `ownerAddress` currently hold this asset, per the rail's source of truth? */
  verifyOwnership(asset: AssetDescriptor, ownerAddress: string): Promise<boolean>;
  /** Best-effort dispute clawback; only meaningful when capabilities().supportsReclaim. */
  reclaim?(ref: string): Promise<AssetTransferResult>;
  dispute?(ref: string): Promise<void>;
  freeze?(ref: string): Promise<void>;
}

/** Registry + selector, mirroring SettlementService — asset-kind lookup instead of rail family. */
export class AssetTransferService {
  private readonly rails: Record<string, AssetTransferRail> = {};

  register(rail: AssetTransferRail): void {
    this.rails[rail.railId] = rail;
  }

  get(railId: string): AssetTransferRail {
    const rail = this.rails[railId];
    if (!rail) throw new Error(`no asset-transfer rail registered: ${railId}`);
    return rail;
  }

  byAssetKind(kind: AssetKind): AssetTransferRail[] {
    return Object.values(this.rails).filter((r) => r.capabilities().assetKinds.includes(kind));
  }

  /** Execute requires a non-empty approval token hash; no self-authorized transfer (§13.5). */
  async execute(approved: ApprovedAssetTransfer): Promise<AssetTransferResult> {
    if (!approved.approvalTokenHash) {
      throw new Error("refusing to execute asset transfer without an approved action token");
    }
    return this.get(approved.railId).execute(approved);
  }
}
