/**
 * §11 Match scoring V1.
 *
 * Deterministic, versioned CODE that pairs one demand against one supply
 * candidate and produces the five §6.6 sub-scores (semantic, constraint,
 * geography, timing, quality) plus a total and a human-readable explanation.
 * Like {@link scoreOpportunity}, the combining formula lives here so matches
 * are reproducible and auditable; an LLM may later estimate components but
 * never the weights.
 *
 * All money is in minor units (cents). V1 source data carries no geo/timing
 * constraints, so those axes are neutral-permissive (1.0) — there is no
 * constraint to violate. They become discriminating once connectors emit
 * location/deadline fields; the weights are already reserved here.
 */
import { clamp01 } from "./index";

export const MATCH_VERSION = "v1";

/** Minimum total below which a pair is not worth turning into an opportunity. */
export const MATCH_MIN_TOTAL = 0.2;

export interface MatchDemand {
  description: string;
  category: string | null;
  /** What the buyer will pay (minor units). */
  targetPriceMinor: number | null;
  /** Hard ceiling the buyer will pay (minor units). */
  maxBudgetMinor: number | null;
}

export interface MatchSupply {
  title: string;
  description: string;
  category: string | null;
  /** Acquisition/list price (minor units). */
  priceMinor: number | null;
}

export interface MatchScores {
  semantic: number;
  constraint: number;
  geography: number;
  timing: number;
  quality: number;
  total: number;
}

export interface MatchExplanation {
  categoryAligned: boolean;
  /** null when budget or supply price is unknown. */
  withinBudget: boolean | null;
  sharedTerms: string[];
  rationale: string;
}

export interface MatchResult extends MatchScores {
  version: string;
  explanation: MatchExplanation;
}

/**
 * Total blends the two axes that actually discriminate on V1 source data —
 * term recall (semantic) and budget fit (constraint) — then gates on category.
 * A cross-category pair cannot become a strong match however well terms/budget
 * align. geography/timing are stored neutral (1.0) and reserved for when
 * connectors emit location/deadline data; they do not yet enter `total`.
 */
const SEMANTIC_WEIGHT = 0.6;
const BUDGET_WEIGHT = 0.4;
const CATEGORY_FACTOR = { aligned: 1, unknown: 0.85, mismatch: 0.35 } as const;

const STOPWORDS: Record<string, true> = {
  the: true, and: true, for: true, with: true, you: true, your: true, our: true,
  this: true, that: true, need: true, want: true, looking: true, under: true,
  over: true, delivered: true, delivery: true, week: true, weekend: true,
  new: true, used: true, each: true, per: true, lot: true, boxed: true, grade: true,
};

/** Deterministic content tokens: lowercase alphanumerics, length >= 3, no stopwords. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS[raw]) out.add(raw);
  }
  return out;
}

function intersectSorted(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const t of a) if (b.has(t)) shared.push(t);
  return shared.sort();
}

/**
 * Score a demand/supply pair. Pure and total: identical inputs always yield an
 * identical result. No exceptions; unknown fields degrade to neutral 0.5.
 */
export function matchDemandToSupply(demand: MatchDemand, supply: MatchSupply): MatchResult {
  const demandTokens = tokenize(demand.description);
  const supplyTokens = tokenize(`${supply.title} ${supply.description}`);
  const sharedTerms = intersectSorted(demandTokens, supplyTokens);

  // Recall of the buyer's terms in the supply listing.
  const semantic = demandTokens.size === 0 ? 0 : clamp01(sharedTerms.length / demandTokens.size);

  const categoryAligned =
    demand.category !== null && supply.category !== null && demand.category === supply.category;
  const categoryMismatch =
    demand.category !== null && supply.category !== null && demand.category !== supply.category;
  const categoryFactor = categoryAligned
    ? CATEGORY_FACTOR.aligned
    : categoryMismatch
      ? CATEGORY_FACTOR.mismatch
      : CATEGORY_FACTOR.unknown;

  const budgetRef = demand.maxBudgetMinor ?? demand.targetPriceMinor;
  let withinBudget: boolean | null = null;
  // Budget fit is the §6.6 constraint sub-score; neutral 0.5 when unknown.
  let constraint = 0.5;
  if (budgetRef !== null && supply.priceMinor !== null && supply.priceMinor > 0) {
    withinBudget = supply.priceMinor <= budgetRef;
    // Within budget scores 1.0; over budget decays with how far past it sits.
    constraint = withinBudget ? 1 : clamp01(budgetRef / supply.priceMinor);
  }

  const geography = 1;
  const timing = 1;
  // Descriptive alignment as a quality proxy until quality constraints are parsed.
  const quality = clamp01(0.5 + 0.5 * semantic);

  const total = clamp01(categoryFactor * (SEMANTIC_WEIGHT * semantic + BUDGET_WEIGHT * constraint));

  return {
    semantic,
    constraint,
    geography,
    timing,
    quality,
    total,
    version: MATCH_VERSION,
    explanation: {
      categoryAligned,
      withinBudget,
      sharedTerms,
      rationale: buildRationale(demand, supply, categoryAligned, withinBudget, sharedTerms),
    },
  };
}

function buildRationale(
  demand: MatchDemand,
  supply: MatchSupply,
  categoryAligned: boolean,
  withinBudget: boolean | null,
  sharedTerms: string[],
): string {
  const parts: string[] = [];
  parts.push(
    categoryAligned
      ? `category ${supply.category} aligned`
      : demand.category === null
        ? "category unspecified"
        : `category mismatch (${demand.category} vs ${supply.category ?? "none"})`,
  );
  const budgetRef = demand.maxBudgetMinor ?? demand.targetPriceMinor;
  if (withinBudget === null) parts.push("budget unknown");
  else parts.push(`${supply.priceMinor} ${withinBudget ? "within" : "over"} budget ${budgetRef}`);
  parts.push(sharedTerms.length ? `shared: ${sharedTerms.join(",")}` : "no shared terms");
  return parts.join("; ");
}
