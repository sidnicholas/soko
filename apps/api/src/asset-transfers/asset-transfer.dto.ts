import { z } from "zod";
import { AssetDescriptor } from "@opportunity-os/contracts";

/** Create an asset-transfer plan for a transaction; prepares the rail's reference immediately (§19). */
export const CreateAssetTransferPlanSchema = z.object({
  transactionId: z.string().uuid(),
  provider: z.string().min(1),
  asset: AssetDescriptor,
  toAddress: z.string().min(1),
});
export type CreateAssetTransferPlanBody = z.infer<typeof CreateAssetTransferPlanSchema>;
