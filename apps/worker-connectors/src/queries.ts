import type { DemandSpecification } from "@opportunity-os/contracts";

/** Words that describe the request, not the item ("Need a … under $220, delivered this week"). */
const STOPWORDS = new Set([
  "a", "an", "the", "i", "im", "i'm", "me", "my", "we", "our", "need", "needs", "want", "wanted", "wants",
  "looking", "look", "for", "to", "buy", "find", "get", "some", "any", "please", "with", "and", "or", "of",
  "in", "on", "by", "at", "from", "under", "below", "less", "than", "max", "maximum", "around", "about",
  "budget", "up", "within", "delivered", "delivery", "shipped", "shipping", "ship", "this", "next", "week",
  "weeks", "month", "today", "tomorrow", "asap", "soon", "urgent", "urgently", "cheap", "new", "used", "is", "be",
  "it", "its", "something", "one",
]);

const MAX_TERMS = 5;

/**
 * Turns a free-text demand description into a marketplace search term: keeps
 * the item words, drops filler, prices and timing. Marketplace search APIs
 * AND their terms, so a whole sentence would match nothing.
 */
export function searchQueryFromDescription(description: string): string {
  const terms = description
    .toLowerCase()
    .replace(/\$\s?\d[\d,.]*k?/g, " ")
    .split(/[^a-z0-9'-]+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return [...new Set(terms)].slice(0, MAX_TERMS).join(" ");
}

/**
 * One search term per active mission (deduplicated, capped per cycle so a busy
 * system can't fan out into hundreds of API calls), or the seed term when no
 * mission yields one.
 */
export function searchQueries(missions: { demandSpec: DemandSpecification }[], seed: string, cap = 10): string[] {
  const queries = [...new Set(missions.map((m) => searchQueryFromDescription(m.demandSpec.what.description)).filter((q) => q.length > 0))];
  return queries.length > 0 ? queries.slice(0, cap) : [seed];
}
