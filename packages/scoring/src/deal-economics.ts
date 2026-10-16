/**
 * Deal economics (PRD v2 FR-04 and §2, ADR-039): delivered cost, net profit,
 * capital, probability-adjusted profit and time to cash, kept separate and
 * versioned. Deterministic: a model may estimate cost lines, this code adds
 * them up, fills the missing ones from stated assumptions, and gates the deal.
 * Never ranks on a headline spread.
 */

export const DEAL_ECONOMICS_VERSION = "deal-economics-1";

export type Range = [number, number];
/** brokerage: paid a fee or commission for connecting the parties. principal: buys and resells. service: sells own work. */
export type DealMode = "brokerage" | "principal" | "service";
export type CostKind =
  | "purchase"
  | "freight"
  | "duties"
  | "taxes"
  | "insurance"
  | "payment_fees"
  | "fx"
  | "returns"
  | "chargebacks"
  | "financing"
  | "commissions"
  | "other";
export type CostLabel = "source_fact" | "estimate" | "default_assumption";

export interface CostLine {
  kind: CostKind;
  /** USD, [low, high]. */
  usd: Range;
  label: CostLabel;
  note?: string;
}

export interface DealEconomicsInput {
  mode: DealMode;
  /** What the end buyer pays in the whole transaction, when known. */
  grossRevenueUsd: Range | null;
  /** What the user receives: the fee or commission (brokerage, service) or the sale proceeds (principal). */
  userRevenueUsd: Range;
  /** Lines stated in the source or estimated by the model. Missing kinds are filled per mode. */
  costLines: CostLine[];
  capitalRequiredUsd: number;
  /** Chance the user is actually paid, [low, high]. */
  probability: Range;
  /** Days from now until cash is collected, [low, high]; null = unknown. */
  daysToCash: Range | null;
  /** Buyer and seller in different currencies. */
  crossCurrency?: boolean;
}

export type ProfitTier = "high" | "medium" | "low" | "marginal" | "negative";
export type EconomicsGate = "negative_net_economics" | "capital_exposure";

export interface DealEconomics {
  version: typeof DEAL_ECONOMICS_VERSION;
  mode: DealMode;
  grossRevenueUsd: Range | null;
  /** Principal: sale proceeds minus purchase. Brokerage and service: the fee itself. */
  grossSpreadUsd: Range;
  costs: CostLine[];
  totalCostUsd: Range;
  netProfitUsd: Range;
  capitalRequiredUsd: number;
  probability: Range;
  /** Net profit × probability. A loss stays a loss. */
  expectedProfitUsd: Range;
  daysToCash: Range;
  tier: ProfitTier;
  gates: EconomicsGate[];
}

/** Assumptions for cost lines nobody stated, as fractions of the base they apply to. */
export const DEFAULT_ASSUMPTIONS = {
  /** Card/transfer fees on money the user receives. */
  paymentFeeRate: [0.02, 0.035] as Range,
  /** Principal resale only. */
  returnsRate: [0.01, 0.04] as Range,
  chargebackRate: [0, 0.01] as Range,
  /** Freight as a share of sale value when a principal deal states none. */
  freightRate: [0.05, 0.15] as Range,
  fxRate: [0.01, 0.03] as Range,
  /** Annual cost of tied-up capital. */
  financingApr: 0.12,
  /** When nobody says how long until cash. */
  daysToCash: [14, 60] as Range,
} as const;

/** Net-profit tiers on the middle of the range, USD. */
export const PROFIT_TIERS: { tier: Exclude<ProfitTier, "negative">; minUsd: number }[] = [
  { tier: "high", minUsd: 1000 },
  { tier: "medium", minUsd: 250 },
  { tier: "low", minUsd: 50 },
  { tier: "marginal", minUsd: 0 },
];

const order = (r: Range): Range => (r[0] <= r[1] ? [r[0], r[1]] : [r[1], r[0]]);
const round2 = (n: number) => Math.round(n * 100) / 100;
const scale = (base: Range, rate: Range): Range => [round2(base[0] * rate[0]), round2(base[1] * rate[1])];
const mid = (r: Range) => (r[0] + r[1]) / 2;

/** The cost lines a deal of this mode needs, with assumptions filling any nobody stated. */
export function completeCosts(input: DealEconomicsInput): CostLine[] {
  const stated = input.costLines.map((c) => ({ ...c, usd: order(c.usd) }));
  const has = (k: CostKind) => stated.some((c) => c.kind === k);
  const revenue = order(input.userRevenueUsd);
  const days = order(input.daysToCash ?? DEFAULT_ASSUMPTIONS.daysToCash);
  const lines = [...stated];
  const add = (kind: CostKind, usd: Range, note: string) => {
    if (!has(kind)) lines.push({ kind, usd, label: "default_assumption", note });
  };
  add("payment_fees", scale(revenue, DEFAULT_ASSUMPTIONS.paymentFeeRate), "2–3.5% on money received");
  if (input.crossCurrency) add("fx", scale(revenue, DEFAULT_ASSUMPTIONS.fxRate), "1–3% currency conversion");
  if (input.mode === "principal") {
    add("freight", scale(revenue, DEFAULT_ASSUMPTIONS.freightRate), "5–15% of sale value; none stated");
    add("returns", scale(revenue, DEFAULT_ASSUMPTIONS.returnsRate), "1–4% returns allowance");
    add("chargebacks", scale(revenue, DEFAULT_ASSUMPTIONS.chargebackRate), "0–1% chargeback allowance");
  }
  if (input.capitalRequiredUsd > 0) {
    const perDay = (input.capitalRequiredUsd * DEFAULT_ASSUMPTIONS.financingApr) / 365;
    add("financing", [round2(perDay * days[0]), round2(perDay * days[1])], `${DEFAULT_ASSUMPTIONS.financingApr * 100}% a year on capital until cash`);
  }
  return lines;
}

/**
 * Full economics for one deal. `maxCapitalUsd` is the capital exposure the
 * operator accepts per deal; above it the deal is gated, not discarded.
 */
export function dealEconomics(input: DealEconomicsInput, opts: { maxCapitalUsd: number }): DealEconomics {
  const costs = completeCosts(input);
  const totalCostUsd: Range = [round2(costs.reduce((s, c) => s + c.usd[0], 0)), round2(costs.reduce((s, c) => s + c.usd[1], 0))];
  const revenue = order(input.userRevenueUsd);
  // Lowest net = least revenue and most cost; highest net = the reverse.
  const netProfitUsd: Range = [round2(revenue[0] - totalCostUsd[1]), round2(revenue[1] - totalCostUsd[0])];
  const purchase = costs.filter((c) => c.kind === "purchase");
  const grossSpreadUsd: Range =
    input.mode === "principal"
      ? [round2(revenue[0] - purchase.reduce((s, c) => s + c.usd[1], 0)), round2(revenue[1] - purchase.reduce((s, c) => s + c.usd[0], 0))]
      : revenue;
  const p = order([clamp01(input.probability[0]), clamp01(input.probability[1])]);
  const expectedProfitUsd = order([round2(netProfitUsd[0] * (netProfitUsd[0] >= 0 ? p[0] : p[1])), round2(netProfitUsd[1] * (netProfitUsd[1] >= 0 ? p[1] : p[0]))]);
  const gates: EconomicsGate[] = [];
  if (netProfitUsd[1] <= 0) gates.push("negative_net_economics");
  if (input.capitalRequiredUsd > opts.maxCapitalUsd) gates.push("capital_exposure");
  return {
    version: DEAL_ECONOMICS_VERSION,
    mode: input.mode,
    grossRevenueUsd: input.grossRevenueUsd ? order(input.grossRevenueUsd) : null,
    grossSpreadUsd,
    costs,
    totalCostUsd,
    netProfitUsd,
    capitalRequiredUsd: input.capitalRequiredUsd,
    probability: p,
    expectedProfitUsd,
    daysToCash: order(input.daysToCash ?? DEFAULT_ASSUMPTIONS.daysToCash),
    tier: tierFor(netProfitUsd),
    gates,
  };
}

/** Tier on the middle of the net-profit range; at or below zero is negative. */
export function tierFor(net: Range): ProfitTier {
  const m = mid(net);
  if (m <= 0) return "negative";
  return PROFIT_TIERS.find((t) => m >= t.minUsd)?.tier ?? "marginal";
}

export type RankingProfile = "profit_first" | "expected_value" | "fastest_cash";
export const RANKING_PROFILES: readonly RankingProfile[] = ["profit_first", "expected_value", "fastest_cash"];

const TIER_ORDER: Record<ProfitTier, number> = { high: 0, medium: 1, low: 2, marginal: 3, negative: 4 };

/**
 * Orders deals (PRD v2 §2). profit_first (default): net-profit tier, then
 * probability of close, then time to cash. expected_value: probability-adjusted
 * profit. fastest_cash: time to cash, then net profit. Gated deals always come
 * last, so a negative or over-exposed deal never outranks a viable one.
 */
export function rankDeals<T>(items: T[], economicsOf: (item: T) => DealEconomics | null, profile: RankingProfile = "profit_first"): T[] {
  const key = (item: T) => economicsOf(item);
  return [...items].sort((a, b) => {
    const ea = key(a);
    const eb = key(b);
    if (!ea || !eb) return ea ? -1 : eb ? 1 : 0;
    const ga = ea.gates.length > 0 ? 1 : 0;
    const gb = eb.gates.length > 0 ? 1 : 0;
    if (ga !== gb) return ga - gb;
    if (profile === "expected_value") return mid(eb.expectedProfitUsd) - mid(ea.expectedProfitUsd);
    if (profile === "fastest_cash") return mid(ea.daysToCash) - mid(eb.daysToCash) || mid(eb.netProfitUsd) - mid(ea.netProfitUsd);
    return (
      TIER_ORDER[ea.tier] - TIER_ORDER[eb.tier] ||
      mid(eb.probability) - mid(ea.probability) ||
      mid(ea.daysToCash) - mid(eb.daysToCash) ||
      mid(eb.netProfitUsd) - mid(ea.netProfitUsd)
    );
  });
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
