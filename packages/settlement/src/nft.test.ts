import { describe, it, expect } from "vitest";
import type { AssetDescriptor } from "@opportunity-os/contracts";
import { CircleNftRail } from "./nft";

function nft(locator = "0xcontract:42"): AssetDescriptor {
  return { kind: "nft", chain: "BASE-SEPOLIA", locator, metadataUri: null };
}

describe("CircleNftRail (simulated — no Circle config)", () => {
  it("advertises the nft asset kind only, with no reclaim primitive", () => {
    const rail = new CircleNftRail("BASE-SEPOLIA");
    expect(rail.capabilities()).toEqual({ assetKinds: ["nft"], supportsOwnershipProof: false, supportsReclaim: false });
  });

  it("prepares a reference from contractAddress:tokenId", async () => {
    const rail = new CircleNftRail("BASE-SEPOLIA");
    const prepared = await rail.prepare(nft());
    expect(prepared.reference).toBe("BASE-SEPOLIA:0xcontract:42");
  });

  it("rejects a locator that isn't contractAddress:tokenId", async () => {
    const rail = new CircleNftRail("BASE-SEPOLIA");
    await expect(rail.prepare(nft("not-a-valid-locator"))).rejects.toThrow(/locator/);
  });

  it("execute is deterministic and confirmed in simulated mode", async () => {
    const rail = new CircleNftRail("BASE-SEPOLIA");
    const asset = nft();
    const prepared = await rail.prepare(asset);
    const approved = { railId: rail.railId, reference: prepared.reference, approvalTokenHash: "hash1", asset, toAddress: "0xbuyer" };

    const first = await rail.execute(approved);
    const second = await rail.execute(approved);
    expect(first.status).toBe("confirmed");
    expect(first.externalRef).toBe(second.externalRef);
  });

  it("verifyOwnership is honestly false without a real Circle account to check", async () => {
    const rail = new CircleNftRail("BASE-SEPOLIA");
    expect(await rail.verifyOwnership(nft(), "0xbuyer")).toBe(false);
  });
});
