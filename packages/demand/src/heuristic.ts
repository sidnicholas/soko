import { DemandSpecification, type Urgency } from "@opportunity-os/contracts";

/** Structured hints supplied alongside free text (e.g. public intake fields). */
export interface DemandHints {
  currency?: string;
  budgetMaxMinor?: number;
  urgency?: Urgency;
  neededBy?: string;
}

export interface DemandParseInput {
  text: string;
  hints?: DemandHints;
}

/** Keyword -> V1 category. First matching token wins (§4 opportunity universe). */
const CATEGORY_KEYWORDS: Record<string, string> = {
  monitor: "electronics",
  laptop: "electronics",
  computer: "electronics",
  phone: "electronics",
  tablet: "electronics",
  camera: "electronics",
  cable: "electronics",
  headphones: "electronics",
  tv: "electronics",
  chair: "furniture",
  desk: "furniture",
  table: "furniture",
  sofa: "furniture",
  couch: "furniture",
  shelf: "furniture",
  cabinet: "furniture",
  car: "vehicles",
  truck: "vehicles",
  vehicle: "vehicles",
  motorcycle: "vehicles",
  bike: "vehicles",
  shirt: "apparel",
  shoes: "apparel",
  jacket: "apparel",
  dress: "apparel",
};

const MONEY_RE = /\$\s?([\d,]+(?:\.\d{1,2})?)/;
const MAX_BUDGET_CUES = ["under", "below", "max", "maximum", "budget", "up to", "no more than", "at most", "less than"];

function detectCategory(text: string): string | null {
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const category = CATEGORY_KEYWORDS[token];
    if (category) return category;
  }
  return null;
}

/** First `$`-denominated amount, in minor units, flagged as a ceiling when the text hints one. */
function detectBudget(text: string): { amountMinor: number; isMax: boolean } | null {
  const match = MONEY_RE.exec(text);
  if (!match) return null;
  const dollars = Number(match[1]!.replaceAll(",", ""));
  if (!Number.isFinite(dollars)) return null;
  const lower = text.toLowerCase();
  return { amountMinor: Math.round(dollars * 100), isMax: MAX_BUDGET_CUES.some((cue) => lower.includes(cue)) };
}

function detectUrgency(text: string): Urgency {
  const t = text.toLowerCase();
  if (/asap|immediately|right now|urgent|emergency/.test(t)) return "immediate";
  if (/today|tonight/.test(t)) return "today";
  if (/this week|within days|few days|couple of days|by (mon|tue|wed|thu|fri|sat|sun)/.test(t)) return "days";
  if (/next month|scheduled|by \w+ \d/.test(t)) return "scheduled";
  return "flexible";
}

function detectFulfillment(text: string): "ship" | "pickup" | "onsite" | "digital" | "other" {
  const t = text.toLowerCase();
  if (/pick ?up|local pickup|collect/.test(t)) return "pickup";
  if (/ship|deliver|delivery|mail|courier/.test(t)) return "ship";
  if (/download|digital|online|license|ebook|software/.test(t)) return "digital";
  if (/on ?site|at my|installation|install at/.test(t)) return "onsite";
  return "other";
}

/**
 * Deterministic §7 demand structuring from free text: no network, no model.
 * Serves as the parser's reliable backbone and the fallback when the LLM path
 * is unavailable or returns an unusable payload. Never invents budgets/dates
 * not present in the text.
 */
export function heuristicDemandSpec(input: DemandParseInput): DemandSpecification {
  const { text } = input;
  const category = detectCategory(text);
  const budget = detectBudget(text);
  const currency = input.hints?.currency ?? "USD";
  const money = budget ? { amount: budget.amountMinor, currency } : null;

  return DemandSpecification.parse({
    what: { description: text },
    budget: {
      flexible: budget === null,
      ...(money && budget!.isMax ? { maximum: money } : {}),
      ...(money && !budget!.isMax ? { target: money } : {}),
    },
    quality: {
      constraints: category ? [{ field: "category", operator: "eq", value: category, hard: false }] : [],
    },
    timing: { urgency: detectUrgency(text) },
    payment: { acceptableMethods: ["card"] },
    fulfillment: { type: detectFulfillment(text) },
    flexibility: { substitutesAllowed: true, negotiableFields: ["price"], nonNegotiables: [] },
    negotiationAuthorization: { mayPrepare: false, maySend: false },
  });
}
