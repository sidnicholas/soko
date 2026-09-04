import type { ConnectorPolicy } from "@opportunity-os/contracts";
import { makeHttpApiConnector } from "./adapters";
import type { SourceConnector } from "./index";

/**
 * First real (non-fixture) connector — the eBay Browse API. Official,
 * OAuth2 client-credentials app token (no user auth, no scraping): permitted
 * for unattended automation under §17/ADR-014 (`automation: "official_api"`).
 */
export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  /** eBay marketplace to search, e.g. "EBAY_US" (default) or "EBAY_GB". */
  marketplaceId?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface EbayItemSummary {
  itemId?: string;
  title?: string;
  shortDescription?: string;
  itemWebUrl?: string;
  price?: { value?: string; currency?: string };
  categories?: { categoryName?: string }[];
}

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

const EBAY_POLICY: ConnectorPolicy = {
  automation: "official_api",
  respects_robots: true,
  allowed_categories: [],
  notes: "eBay Browse API — official OAuth2 client-credentials app token, no user data, no scraping.",
};

/** USD/major-currency decimal string (eBay's `price.value`) -> integer minor units, this system's universal Money unit. */
function toMinorUnits(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function makeEbayConnector(config: EbayConfig): SourceConnector {
  const doFetch = config.fetchImpl ?? fetch;
  const marketplaceId = config.marketplaceId ?? "EBAY_US";
  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basicAuth}`,
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    });
    if (!res.ok) throw new Error(`ebay oauth token request failed: ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("ebay oauth token response had no access_token");
    cachedToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 7200) * 1000 - TOKEN_EXPIRY_BUFFER_MS,
    };
    return cachedToken.value;
  }

  return makeHttpApiConnector({
    id: "ebay-browse",
    capabilities: ["supply", "pricing"],
    policy: EBAY_POLICY,
    fetchImpl: config.fetchImpl,
    async buildRequest(input) {
      const token = await accessToken();
      const params = new URLSearchParams({ q: input.query, limit: String(Math.min(input.max, 200)) });
      if (input.category) params.set("category_ids", input.category);
      return {
        url: `${SEARCH_URL}?${params.toString()}`,
        init: {
          headers: {
            authorization: `Bearer ${token}`,
            "x-ebay-c-marketplace-id": marketplaceId,
          },
        },
      };
    },
    mapResponse(json) {
      if (!json || typeof json !== "object" || !("itemSummaries" in json)) return [];
      const items = (json as { itemSummaries?: unknown }).itemSummaries;
      if (!Array.isArray(items)) return [];
      return (items as EbayItemSummary[])
        .filter((item): item is EbayItemSummary & { itemId: string } => typeof item.itemId === "string")
        .map((item) => ({
          kind: "supply" as const,
          externalId: item.itemId,
          uri: item.itemWebUrl,
          content: {
            title: item.title ?? "untitled",
            description: item.shortDescription ?? item.title ?? "",
            category: item.categories?.[0]?.categoryName ?? null,
            price: toMinorUnits(item.price?.value),
            currency: item.price?.currency ?? "USD",
          },
        }));
    },
  });
}
