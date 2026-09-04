import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { AssetDescriptor } from "@opportunity-os/contracts";
import type {
  ApprovedAssetTransfer,
  AssetTransferCapabilities,
  AssetTransferRail,
  AssetTransferResult,
  AssetTransferStatusResult,
  PreparedAssetTransfer,
} from "./asset-transfer";
import { deterministicUuid, simpleHash, type CircleConfig } from "./stablecoin";

/**
 * §19 crypto-asset expansion, first real rail (backlog item 1 — lowest legal
 * exposure of the four AssetKinds). Reuses the same Circle Developer-
 * Controlled Wallets custody model as `StablecoinRail` (§C-6 "platform never
 * holds keys directly"): Circle's `createTransaction` already supports
 * ERC-721 transfer via `tokenAddress` + `nftTokenIds: [id]` + `amounts:
 * ["1"]`, so this is the same client, same wallet, a different transfer
 * shape — not a new custody integration.
 *
 * Simulated (deterministic, no on-chain call) with no Circle config; real
 * Circle calls otherwise. Not yet live-verified against a real Circle
 * account the way `StablecoinRail` was (see project memory §5 Phase 3) —
 * this is the prototype stage that rail started at before that pass.
 */
export class CircleNftRail implements AssetTransferRail {
  readonly railId = "nft-circle";
  private readonly client?: CircleDeveloperControlledWalletsClient;
  private walletAddressCache?: string;

  constructor(
    private readonly network: string,
    private readonly circle?: CircleConfig,
  ) {
    if (circle) {
      this.client = initiateDeveloperControlledWalletsClient({ apiKey: circle.apiKey, entitySecret: circle.entitySecret });
    }
  }

  private get simulated(): boolean {
    return this.client === undefined;
  }

  capabilities(): AssetTransferCapabilities {
    return {
      assetKinds: ["nft"],
      supportsOwnershipProof: !this.simulated,
      // No on-chain "send it back" primitive tracked here, same honest
      // limitation as StablecoinRail.supportsRefund.
      supportsReclaim: false,
    };
  }

  private locator(asset: AssetDescriptor): { contractAddress: string; tokenId: string } {
    const [contractAddress, tokenId] = asset.locator.split(":");
    if (!contractAddress || !tokenId) {
      throw new Error(`nft AssetDescriptor.locator must be "<contractAddress>:<tokenId>", got "${asset.locator}"`);
    }
    return { contractAddress, tokenId };
  }

  async prepare(asset: AssetDescriptor): Promise<PreparedAssetTransfer> {
    const { contractAddress, tokenId } = this.locator(asset);
    return { railId: this.railId, reference: `${this.network}:${contractAddress}:${tokenId}` };
  }

  /**
   * Unlike a currency transfer, Circle has no separate authorize/capture step
   * for an NFT either: the platform wallet either already holds the token or
   * it doesn't, and the transfer either succeeds or fails at execute() —
   * same shape as `StablecoinRail.execute`, always "pending" in real mode
   * pending webhook/poll reconciliation (ST-13-style, not yet wired for this
   * rail).
   */
  async execute(approved: ApprovedAssetTransfer): Promise<AssetTransferResult> {
    const { contractAddress, tokenId } = this.locator(approved.asset);
    if (this.simulated) {
      const externalRef = `0xsim${simpleHash(approved.reference + approved.approvalTokenHash)}`;
      return { railId: this.railId, externalRef, status: "confirmed" };
    }
    const result = await this.client!.createTransaction({
      walletId: this.circle!.walletId,
      tokenAddress: contractAddress,
      destinationAddress: approved.toAddress,
      amount: ["1"],
      nftTokenIds: [tokenId],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: deterministicUuid(`${approved.approvalTokenHash}:${approved.toAddress}`),
    });
    if (!result.data?.id) throw new Error(`Circle createTransaction returned no transaction id for NFT ${contractAddress}:${tokenId}`);
    return { railId: this.railId, externalRef: result.data.id, status: "pending" };
  }

  async status(ref: string): Promise<AssetTransferStatusResult> {
    if (this.simulated) return { status: "confirmed", externalRef: ref };
    const result = await this.client!.getTransaction({ id: ref });
    const state = result.data?.transaction?.state;
    if (state === "COMPLETE") return { status: "confirmed", externalRef: ref };
    if (state === "FAILED" || state === "DENIED" || state === "CANCELLED" || state === "STUCK") {
      return { status: "failed", externalRef: ref };
    }
    return { status: "pending", externalRef: ref };
  }

  /**
   * Circle only reports holdings of wallets it manages — this can confirm or
   * deny the platform's own custodial wallet, never an arbitrary external
   * `ownerAddress`. Honest false for anything else, not a fake check.
   */
  async verifyOwnership(asset: AssetDescriptor, ownerAddress: string): Promise<boolean> {
    if (this.simulated) return false;
    const walletAddress = await this.custodialWalletAddress();
    if (ownerAddress.toLowerCase() !== walletAddress.toLowerCase()) return false;
    const { contractAddress, tokenId } = this.locator(asset);
    const balance = await this.client!.getWalletNFTBalance({ id: this.circle!.walletId, tokenAddresses: [contractAddress] });
    return (balance.data?.nfts ?? []).some((n) => n.nftTokenId === tokenId);
  }

  private async custodialWalletAddress(): Promise<string> {
    if (this.walletAddressCache) return this.walletAddressCache;
    const wallet = await this.client!.getWallet({ id: this.circle!.walletId });
    const address = wallet.data?.wallet?.address;
    if (!address) throw new Error(`Circle wallet ${this.circle!.walletId} has no address`);
    this.walletAddressCache = address;
    return address;
  }
}
