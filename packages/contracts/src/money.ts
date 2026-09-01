import { z } from "zod";

/** ISO-4217 fiat code or a stablecoin/asset symbol (e.g. USD, USDC). */
export const CurrencyCode = z.string().min(3).max(12);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * Money is always stored in integer minor units (cents, or the smallest
 * on-chain unit for the asset) to avoid floating point drift in economics.
 */
export const Money = z.object({
  amount: z.number().int(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;
