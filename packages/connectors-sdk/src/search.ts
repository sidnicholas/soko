/**
 * Provider-agnostic web search (AIOOS §2): the reasoning layer calls
 * `search({ query, ... })` without being tied to one vendor. Results are
 * untrusted third-party content — callers fence them before any LLM sees them.
 */
export interface WebSearchQuery {
  query: string;
  /** Results wanted (providers may return fewer). */
  count?: number;
  /** Recency window: past day / week / month / year. */
  freshness?: "day" | "week" | "month" | "year";
}

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  hostname: string;
  /** ISO timestamp when the provider knows the page date. */
  publishedAt: string | null;
  /** Provider's human-readable age ("3 days ago"), kept as a source fact. */
  ageText: string | null;
  provider: string;
}

export interface SearchProvider {
  readonly id: string;
  /** Marginal cost of one query, for the search budget ledger (AIOOS §22). */
  readonly costPerQueryUsd: number;
  search(q: WebSearchQuery): Promise<WebSearchResult[]>;
}

export interface BraveSearchConfig {
  apiKey: string;
  /** Override if your plan's rate differs ($5 per 1,000 requests at 2026 list price). */
  costPerQueryUsd?: number;
  fetchImpl?: typeof fetch;
}

interface BraveResult {
  url?: string;
  title?: string;
  description?: string;
  hostname?: string;
  meta_url?: { hostname?: string };
  page_age?: string;
  age?: string;
}

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

/** Brave snippets carry inline <strong> highlighting. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Brave Search API (official, key-authenticated web index). */
export function makeBraveSearch(config: BraveSearchConfig): SearchProvider {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    id: "brave",
    costPerQueryUsd: config.costPerQueryUsd ?? 0.005,
    async search(q) {
      const params = new URLSearchParams({ q: q.query, count: String(Math.min(q.count ?? 20, 20)) });
      if (q.freshness) params.set("freshness", BRAVE_FRESHNESS[q.freshness]);
      const res = await doFetch(`${BRAVE_URL}?${params.toString()}`, {
        headers: { accept: "application/json", "x-subscription-token": config.apiKey },
      });
      if (!res.ok) throw new Error(`brave search ${res.status}`);
      const json = (await res.json()) as { web?: { results?: BraveResult[] } };
      return (json.web?.results ?? [])
        .filter((r): r is BraveResult & { url: string } => typeof r.url === "string")
        .map((r) => {
          const published = r.page_age && !Number.isNaN(Date.parse(r.page_age)) ? new Date(r.page_age).toISOString() : null;
          return {
            url: r.url,
            title: stripTags(r.title ?? ""),
            snippet: stripTags(r.description ?? ""),
            hostname: (r.meta_url?.hostname ?? r.hostname ?? hostOf(r.url)).replace(/^www\./, ""),
            publishedAt: published,
            ageText: r.age ?? null,
            provider: "brave",
          };
        });
    },
  };
}
