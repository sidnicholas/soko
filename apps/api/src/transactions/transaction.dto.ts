import { z } from "zod";
import { Money, RailFamily } from "@opportunity-os/contracts";

export const SettlementPlanSchema = z.object({
  rail_family: RailFamily.optional(),
  provider: z.string().min(1).optional(),
  asset: z.string().min(1).optional(),
  total_amount: Money.optional(),
  human_release_policy: z.string().min(1).optional(),
});

export const ProposeTransactionSchema = z.object({
  opportunityId: z.string().uuid(),
  grossAmountMinor: z.number().int().positive(),
  currency: z.string().min(3).max(12).default("USD"),
});
export type ProposeTransactionBody = z.infer<typeof ProposeTransactionSchema>;
export type SettlementPlanBody = z.infer<typeof SettlementPlanSchema>;
