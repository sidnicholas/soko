import { z } from "zod";
import { Money, RailFamily } from "@opportunity-os/contracts";

export const SettlementPlanSchema = z.object({
  rail_family: RailFamily.optional(),
  provider: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  total_amount: Money.optional(),
  human_release_policy: z.string().min(1).optional(),
});
export type SettlementPlanBody = z.infer<typeof SettlementPlanSchema>;
