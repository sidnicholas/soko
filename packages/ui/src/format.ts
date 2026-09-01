import type { Money } from "@opportunity-os/contracts";

/**
 * Renders {@link Money} (integer minor units, §6/money.ts) as a display string.
 * Falls back to a plain amount + symbol for non-ISO assets (e.g. USDC) that
 * `Intl.NumberFormat` cannot format as a currency.
 */
export function formatMoney(money: Money | null | undefined, opts?: { dash?: string }): string {
  if (!money) return opts?.dash ?? "—";
  const major = money.amount / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: money.currency,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(major);
    return `${n} ${money.currency}`;
  }
}

/** Renders a 0..1 score as a whole-number percentage (e.g. 0.82 -> "82%"). */
export function formatScore(score: number | null | undefined, opts?: { dash?: string }): string {
  if (score === null || score === undefined || Number.isNaN(score)) return opts?.dash ?? "—";
  return `${Math.round(score * 100)}%`;
}

/** Compact absolute + relative timestamp for timelines and tables. */
export function formatDateTime(iso: string | null | undefined, opts?: { dash?: string }): string {
  if (!iso) return opts?.dash ?? "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `time_to_cash_minutes` -> a human duration (e.g. 90 -> "1h 30m"). */
export function formatDuration(minutes: number | null | undefined, opts?: { dash?: string }): string {
  if (minutes === null || minutes === undefined) return opts?.dash ?? "—";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  const days = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${days}d` : `${days}d ${rh}h`;
}
