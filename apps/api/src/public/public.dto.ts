import { z } from "zod";
import { CurrencyCode, Urgency } from "@opportunity-os/contracts";

/** Minimal public demand intake (§3.1(21), §16 /public/requests). */
export const PublicRequestSchema = z.object({
  description: z.string().min(1),
  title: z.string().min(1).optional(),
  currency: CurrencyCode.optional(),
  /** Maximum budget in integer minor units (cents). */
  budget_max: z.number().int().positive().optional(),
  needed_by: z.string().optional(),
  urgency: Urgency.optional(),
});
export type PublicRequestBody = z.infer<typeof PublicRequestSchema>;
