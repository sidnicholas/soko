import { z } from "zod";
import { zId, zIso } from "./ids";
import { AssetKind, AssetTransferStatus } from "./enums";

/**
 * §19 crypto-asset expansion — a non-fungible/position resource transacted
 * alongside currency settlement. Chain-agnostic: rails interpret `locator`
 * themselves (contract+tokenId for an NFT, a vault+position id for a DeFi
 * position, a feed id for a data-feed subscription, ...).
 */
export const AssetDescriptor = z.object({
  kind: AssetKind,
  chain: z.string(),
  locator: z.string(),
  metadataUri: z.string().nullable().default(null),
});
export type AssetDescriptor = z.infer<typeof AssetDescriptor>;

/** Asset-transfer counterpart to SettlementPlan — tracked separately since it moves an object, not an amount. */
export const AssetTransferPlan = z.object({
  id: zId,
  transaction_id: zId,
  provider: z.string(),
  asset: AssetDescriptor,
  status: AssetTransferStatus,
  created_at: zIso,
});
export type AssetTransferPlan = z.infer<typeof AssetTransferPlan>;
