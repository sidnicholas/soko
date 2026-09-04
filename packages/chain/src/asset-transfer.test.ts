import { describe, it, expect } from "vitest";
import type { AssetDescriptor } from "@opportunity-os/contracts";
import { ProgrammableAssetTransferAdapter } from "./asset-transfer";

function nft(locator = "0xabc:42"): AssetDescriptor {
  return { kind: "nft", chain: "local", locator, metadataUri: null };
}

describe("ProgrammableAssetTransferAdapter", () => {
  it("prepares a holding then transfers ownership on execute", async () => {
    const rail = new ProgrammableAssetTransferAdapter();
    const asset = nft();
    const prepared = await rail.prepare(asset);

    expect(await rail.verifyOwnership(asset, "0xbuyer")).toBe(false);

    const result = await rail.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash: "abc123",
      asset,
      toAddress: "0xbuyer",
    });

    expect(result.status).toBe("confirmed");
    expect(await rail.verifyOwnership(asset, "0xbuyer")).toBe(true);
    expect((await rail.status(prepared.reference)).status).toBe("confirmed");
  });

  it("refuses to execute once frozen or disputed", async () => {
    const rail = new ProgrammableAssetTransferAdapter();
    const asset = nft("0xdef:7");
    const prepared = await rail.prepare(asset);
    await rail.freeze(prepared.reference);

    const result = await rail.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash: "abc123",
      asset,
      toAddress: "0xbuyer",
    });

    expect(result.status).toBe("failed");
    expect(await rail.verifyOwnership(asset, "0xbuyer")).toBe(false);
  });

  it("reclaim clears ownership and marks the holding reclaimed", async () => {
    const rail = new ProgrammableAssetTransferAdapter();
    const asset = nft("0xghi:9");
    const prepared = await rail.prepare(asset);
    await rail.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash: "abc123",
      asset,
      toAddress: "0xbuyer",
    });

    const reclaimed = await rail.reclaim(prepared.reference);
    expect(reclaimed.status).toBe("confirmed");
    expect(await rail.verifyOwnership(asset, "0xbuyer")).toBe(false);
    expect((await rail.status(prepared.reference)).status).toBe("reclaimed");
  });

  it("advertises all four crypto-asset kinds without hard-blocking any", () => {
    const rail = new ProgrammableAssetTransferAdapter();
    expect(rail.capabilities().assetKinds).toEqual(["nft", "defi_position", "data_feed_subscription", "synthetic_position"]);
  });
});
