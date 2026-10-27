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

export interface SerperSearchConfig {
  apiKey: string;
  /** Override if your plan's rate differs (about $1 per 1,000 queries on 2026 list pricing). */
  costPerQueryUsd?: number;
  /** Clock for turning "3 days ago" into a date; injectable for tests. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

interface SerperResult {
  link?: string;
  title?: string;
  snippet?: string;
  date?: string;
}

const SERPER_URL = "https://google.serper.dev/search";
const SERPER_FRESHNESS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" } as const;
const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Google's result date: "3 days ago", "1 hour ago" or an absolute date ("Sep 29, 2026"). */
export function serperPublishedAt(date: string | undefined, now: Date): string | null {
  if (!date) return null;
  const rel = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(date.trim());
  if (rel) return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!).toISOString();
  const abs = Date.parse(date);
  return Number.isNaN(abs) ? null : new Date(abs).toISOString();
}

/**
 * Serper (Google web results through an official, key-authenticated API).
 * Supports the `site:` operator and a recency window like Brave. Asks for at
 * most 10 results: larger pages are billed as more than one query.
 */
export function makeSerperSearch(config: SerperSearchConfig): SearchProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());
  return {
    id: "serper",
    costPerQueryUsd: config.costPerQueryUsd ?? 0.001,
    async search(q) {
      const body: Record<string, unknown> = { q: q.query, num: Math.min(q.count ?? 10, 10) };
      if (q.freshness) body.tbs = SERPER_FRESHNESS[q.freshness];
      const res = await doFetch(SERPER_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`serper search ${res.status}`);
      const json = (await res.json()) as { organic?: SerperResult[] };
      const at = now();
      return (json.organic ?? [])
        .filter((r): r is SerperResult & { link: string } => typeof r.link === "string")
        .map((r) => ({
          url: r.link,
          title: (r.title ?? "").trim(),
          snippet: (r.snippet ?? "").trim(),
          hostname: hostOf(r.link),
          publishedAt: serperPublishedAt(r.date, at),
          ageText: r.date ?? null,
          provider: "serper",
        }));
    },
  };
}

export interface YouSearchConfig {
  apiKey: string;
  /** Override if your plan's rate differs ($5 per 1,000 calls on 2026 list pricing). */
  costPerQueryUsd?: number;
  fetchImpl?: typeof fetch;
}

interface YouResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

const YOU_URL = "https://ydc-index.io/v1/search";

/**
 * You.com Web Search API (its own web index, key-authenticated). Supports the
 * `site:` operator and a recency window like Brave and Serper. One call is
 * billed the same up to 100 results; the sweep asks for at most 20.
 */
export function makeYouSearch(config: YouSearchConfig): SearchProvider {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    id: "youcom",
    costPerQueryUsd: config.costPerQueryUsd ?? 0.005,
    async search(q) {
      const body: Record<string, unknown> = { query: q.query, count: Math.min(q.count ?? 20, 20) };
      if (q.freshness) body.freshness = q.freshness;
      const res = await doFetch(YOU_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`youcom search ${res.status}`);
      const json = (await res.json()) as { results?: { web?: YouResult[] } };
      return (json.results?.web ?? [])
        .filter((r): r is YouResult & { url: string } => typeof r.url === "string")
        .map((r) => {
          const published = r.page_age && !Number.isNaN(Date.parse(r.page_age)) ? new Date(r.page_age).toISOString() : null;
          return {
            url: r.url,
            title: (r.title ?? "").trim(),
            snippet: (r.description?.trim() || r.snippets?.[0]?.trim() || "").slice(0, 1000),
            hostname: hostOf(r.url),
            publishedAt: published,
            ageText: r.page_age ?? null,
            provider: "youcom",
          };
        });
    },
  };
}
