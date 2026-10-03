import type { ConnectorPolicy } from "@opportunity-os/contracts";
import { makeHttpApiConnector } from "./adapters";
import type { SourceConnector } from "./index";

/**
 * Second real connector — the Reverb public API (music gear marketplace).
 * Official, documented REST API; listing search is public, so it runs keyless,
 * with an optional personal access token for higher rate limits. Permitted for
 * unattended automation under §17/ADR-014 (`automation: "official_api"`).
 */
export interface ReverbConfig {
  /** Optional personal access token (Authorization: Bearer). */
  apiToken?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface ReverbListing {
  id?: number | string;
  title?: string;
  description?: string;
  condition?: { display_name?: string };
  price?: { amount_cents?: number; currency?: string };
  categories?: { full_name?: string }[];
  _links?: { web?: { href?: string } };
}

const SEARCH_URL = "https://api.reverb.com/api/listings";

const REVERB_POLICY: ConnectorPolicy = {
  automation: "official_api",
  respects_robots: true,
  allowed_categories: [],
  notes: "Reverb public API — documented listing search, no user data, no scraping.",
};

/** Listing descriptions are seller HTML; keep a short plain-text summary. */
function plainText(html: string | undefined, max = 500): string {
  if (!html) return "";
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function makeReverbConnector(config: ReverbConfig = {}): SourceConnector {
  return makeHttpApiConnector({
    id: "reverb-listings",
    capabilities: ["supply", "pricing"],
    policy: REVERB_POLICY,
    fetchImpl: config.fetchImpl,
    buildRequest(input) {
      const params = new URLSearchParams({ query: input.query, per_page: String(Math.min(input.max, 50)) });
      const headers: Record<string, string> = { accept: "application/hal+json", "accept-version": "3.0" };
      if (config.apiToken) headers.authorization = `Bearer ${config.apiToken}`;
      return { url: `${SEARCH_URL}?${params.toString()}`, init: { headers } };
    },
    mapResponse(json) {
      if (!json || typeof json !== "object" || !("listings" in json)) return [];
      const listings = (json as { listings?: unknown }).listings;
      if (!Array.isArray(listings)) return [];
      return (listings as ReverbListing[])
        .filter((l): l is ReverbListing & { id: number | string } => l.id !== undefined && l.id !== null)
        .map((l) => {
          const condition = l.condition?.display_name;
          const sourceCategory = l.categories?.[0]?.full_name;
          const summary = plainText(l.description);
          return {
            kind: "supply" as const,
            externalId: String(l.id),
            uri: l._links?.web?.href,
            content: {
              title: l.title ?? "untitled",
              description: [condition, sourceCategory, summary || l.title].filter(Boolean).join(" — "),
              // Reverb is a music-gear marketplace: everything it lists is a
              // musical instrument or gear for one, whatever the subcategory.
              category: "musical_instruments",
              price: typeof l.price?.amount_cents === "number" ? l.price.amount_cents : null,
              currency: l.price?.currency ?? "USD",
            },
          };
        });
    },
  });
}
