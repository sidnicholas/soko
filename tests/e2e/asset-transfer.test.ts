import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { AssetTransferService, CircleNftRail } from "@opportunity-os/settlement";
import { ProgrammableAssetTransferAdapter } from "@opportunity-os/chain";
import {
  getDb,
  closeDb,
  upsertGraphOpportunity,
  createAssetTransferPlan,
  setAssetTransferReference,
  recordAssetTransferResult,
  getAssetTransferPlan,
} from "@opportunity-os/db";
import { hashAssetTransferTerms } from "@opportunity-os/audit";
import type { AssetDescriptor, AssetKind } from "@opportunity-os/contracts";

/**
 * §19 crypto-asset expansion — the reference-tier rail (`ProgrammableAssetTransferAdapter`)
 * already advertises all four AssetKinds (chain/asset-transfer.test.ts proves
 * this in isolation for "nft"); this proves the other three route through the
 * SAME AssetTransferService + asset_transfer_plans persistence path the API
 * layer uses, exactly like CircleNftRail's "nft" wiring, with no kind-specific
 * code anywhere in that path. No real DeFi/data-feed provider exists yet
 * (backlog: DeFi needs a legal read before a live rail, not just code) — this
 * is reference-tier only, same duality every rail here ships with.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

function rails(): AssetTransferService {
  const service = new AssetTransferService();
  service.register(new CircleNftRail("BASE-SEPOLIA"));
  service.register(new ProgrammableAssetTransferAdapter("local"));
  return service;
}

function asset(kind: AssetKind, locator: string): AssetDescriptor {
  return { kind, chain: "local", locator, metadataUri: null };
}

describe.skipIf(!HAS_DB)("asset transfer across all four crypto-asset kinds (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it.each([
    ["defi_position", "aave:usdc-lp-position-1"],
    ["data_feed_subscription", "chainlink:eth-usd-feed-sub-1"],
    ["synthetic_position", "synthetix:sbtc-position-1"],
  ] as const)("prepares and executes a %s transfer end to end", async (kind, locator) => {
    const { opportunityId } = await upsertGraphOpportunity({
      kind: "arbitrage",
      dedupeKey: `asset-transfer-${kind}-${randomUUID()}`,
      expectedRevenueMinor: 0,
      expectedDirectCostMinor: 0,
      expectedNetProfitMinor: 0,
      currency: "USD",
      overallScore: 0.5,
      closeProbability: 0.5,
      customerValueScore: 0.5,
      scoreVersion: "v1",
      nextAction: "transfer",
      source: { test: true },
    });
    const txn = await getDb()
      .insertInto("transactions")
      .values({
        opportunity_id: opportunityId,
        buyer_id: null,
        seller_id: null,
        status: "proposed",
        terms_version: 0,
        terms_hash: "t".repeat(64),
        gross_amount: { amount: 0, currency: "USD" },
        currency: "USD",
        platform_revenue: null,
        settlement_plan_id: null,
        fulfillment_plan_id: null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const service = rails();
    const rail = service.byAssetKind(kind)[0]!;
    expect(rail.railId).toBe("onchain-asset-programmable"); // CircleNftRail only advertises "nft"

    const descriptor = asset(kind, locator);
    const plan = await createAssetTransferPlan({
      transactionId: txn.id,
      provider: rail.railId,
      asset: descriptor,
      toAddress: "0xbuyer",
    });
    expect(plan.status).toBe("pending");

    const prepared = await rail.prepare(descriptor);
    await setAssetTransferReference(plan.id, prepared.reference);

    const approvalTokenHash = hashAssetTransferTerms({ assetTransferPlanId: plan.id, toAddress: "0xbuyer" });
    const execution = await service.execute({
      railId: rail.railId,
      reference: prepared.reference,
      approvalTokenHash,
      asset: descriptor,
      toAddress: "0xbuyer",
    });
    expect(execution.status).toBe("confirmed");

    const final = await recordAssetTransferResult({
      id: plan.id,
      status: execution.status,
      externalRef: execution.externalRef,
      actorId: "operator-1",
    });
    expect(final!.status).toBe("confirmed");
    expect(final!.external_ref).toBe(execution.externalRef);
    expect(await rail.verifyOwnership(descriptor, "0xbuyer")).toBe(true);
    expect((await getAssetTransferPlan(plan.id))!.status).toBe("confirmed");
  });
});
