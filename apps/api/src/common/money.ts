/** Narrow a persisted jsonb Money value ({ amount, currency }) into typed fields. */
export function readMoney(value: unknown): { amountMinor: number; currency: string } | null {
  if (value && typeof value === "object" && "amount" in value) {
    const money = value as { amount: unknown; currency?: unknown };
    if (typeof money.amount === "number") {
      return { amountMinor: money.amount, currency: typeof money.currency === "string" ? money.currency : "USD" };
    }
  }
  return null;
}
