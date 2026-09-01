import type { CategoryPolicy } from "@opportunity-os/contracts";

/**
 * §13 Risk, Compliance, and Anti-Gaming.
 * All heuristics are deterministic code; an LLM may *suggest* signals but the
 * gate decisions live here and are auditable.
 */

/** §13.1 Category gate. Anything unknown or regulated defaults to review/prohibited. */
const CATEGORY_POLICY: Record<string, CategoryPolicy> = {
  electronics: "allowed",
  furniture: "allowed",
  apparel: "allowed",
  home_goods: "allowed",
  office_supplies: "allowed",
  tools: "allowed",
  vehicles: "review_required",
  event_tickets: "review_required",
  collectibles: "review_required",
  firearms: "prohibited_for_v1",
  ammunition: "prohibited_for_v1",
  pharmaceuticals: "prohibited_for_v1",
  alcohol: "prohibited_for_v1",
  tobacco: "prohibited_for_v1",
  securities: "prohibited_for_v1",
  adult: "prohibited_for_v1",
  hazardous_materials: "prohibited_for_v1",
};

export function classifyCategory(category: string | null | undefined): CategoryPolicy {
  if (!category) return "review_required";
  return CATEGORY_POLICY[category.toLowerCase()] ?? "review_required";
}

export function isTransactableInV1(category: string | null | undefined): boolean {
  return classifyCategory(category) === "allowed";
}

/** §13.5 Financial safety limits. */
export interface SpendLimits {
  perActionUsd: number;
  perDayUsd: number;
  allowlistedProviders: readonly string[];
}

export interface SpendCheckInput {
  actionUsd: number;
  spentTodayUsd: number;
  provider: string;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
}

export function checkSpend(limits: SpendLimits, input: SpendCheckInput): GateResult {
  if (!limits.allowlistedProviders.includes(input.provider)) {
    return { allowed: false, reason: `provider not allowlisted: ${input.provider}` };
  }
  if (input.actionUsd > limits.perActionUsd) {
    return { allowed: false, reason: `per-action limit exceeded: ${input.actionUsd} > ${limits.perActionUsd}` };
  }
  if (input.spentTodayUsd + input.actionUsd > limits.perDayUsd) {
    return { allowed: false, reason: `per-day limit exceeded` };
  }
  return { allowed: true };
}

/** §13.3 Prompt-injection defense: detect instruction-like content in untrusted data. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all|previous|prior) (instructions|context)/i,
  /you are now|act as|system prompt/i,
  /disregard (the )?(above|earlier)/i,
  /reveal (your )?(system|prompt|api key|secret)/i,
];

export function detectInjection(content: string): string[] {
  return INJECTION_PATTERNS.filter((re) => re.test(content)).map((re) => re.source);
}

/** §13.4 Marketplace anti-gaming signal aggregation. */
export interface AntiGamingInput {
  contentHash: string;
  seenHashes: readonly string[];
  counterpartyId?: string | null;
  buyerCounterpartyId?: string | null;
  sellerCounterpartyId?: string | null;
  accountCreatedMinutesAgo?: number;
  recentActionsByAccount?: number;
  recentCancellations?: number;
  priceZScore?: number;
}

export interface RiskAssessment {
  fraud_risk: number;
  compliance_risk: number;
  flags: string[];
}

/** Weighted, bounded assessment; higher = riskier. */
export function assessRisk(input: AntiGamingInput, category?: string | null): RiskAssessment {
  const flags: string[] = [];
  let fraud = 0;

  if (input.seenHashes.includes(input.contentHash)) {
    flags.push("duplicate_or_synthetic");
    fraud += 0.3;
  }
  if (
    input.buyerCounterpartyId &&
    input.sellerCounterpartyId &&
    input.buyerCounterpartyId === input.sellerCounterpartyId
  ) {
    flags.push("self_dealing_or_circular");
    fraud += 0.4;
  }
  if ((input.accountCreatedMinutesAgo ?? Infinity) < 60) {
    flags.push("fresh_account_velocity");
    fraud += 0.15;
  }
  if ((input.recentActionsByAccount ?? 0) > 50) {
    flags.push("suspicious_account_velocity");
    fraud += 0.15;
  }
  if ((input.recentCancellations ?? 0) > 3) {
    flags.push("repeated_cancellations");
    fraud += 0.1;
  }
  if (Math.abs(input.priceZScore ?? 0) > 3) {
    flags.push("unusual_price_movement");
    fraud += 0.1;
  }

  const policy = classifyCategory(category);
  const compliance = policy === "prohibited_for_v1" ? 1 : policy === "review_required" ? 0.5 : 0.05;
  if (policy !== "allowed") flags.push(`category_${policy}`);

  return { fraud_risk: Math.min(1, fraud), compliance_risk: compliance, flags };
}
