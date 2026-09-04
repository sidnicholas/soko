import { describe, it, expect } from "vitest";
import { makeEbayConnector } from "./ebay";

function stubFetch(): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (href.includes("/oauth2/token")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "tok-abc", expires_in: 7200, token_type: "Application Access Token" };
        },
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          itemSummaries: [
            {
              itemId: "v1|123456789|0",
              title: "27in 4K Monitor",
              shortDescription: "Refurbished, 12mo warranty",
              itemWebUrl: "https://www.ebay.com/itm/123456789",
              price: { value: "189.00", currency: "USD" },
              categories: [{ categoryName: "Monitors" }],
            },
            { itemId: undefined, title: "malformed, dropped" },
          ],
        };
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("makeEbayConnector", () => {
  it("fetches an OAuth token, searches, and maps items to supply observations", async () => {
    const { fetchImpl, calls } = stubFetch();
    const connector = makeEbayConnector({ clientId: "cid", clientSecret: "csecret", fetchImpl });

    const obs = await connector.search({ query: "4k monitor", max: 10, filters: {} });

    expect(obs).toHaveLength(1);
    expect(obs[0]!.kind).toBe("supply");
    expect(obs[0]!.ref.external_id).toBe("v1|123456789|0");
    expect(obs[0]!.automation).toBe("official_api");
    expect(obs[0]!.content["title"]).toBe("27in 4K Monitor");
    expect(obs[0]!.content["price"]).toBe(18900);
    expect(obs[0]!.content["category"]).toBe("Monitors");

    const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"));
    expect(tokenCall).toBeDefined();
    const searchCall = calls.find((c) => c.url.includes("/item_summary/search"));
    expect(searchCall!.url).toContain("q=4k+monitor");
    expect((searchCall!.init!.headers as Record<string, string>)["authorization"]).toBe("Bearer tok-abc");
  });

  it("caches the access token across searches instead of re-authenticating every call", async () => {
    const { fetchImpl, calls } = stubFetch();
    const connector = makeEbayConnector({ clientId: "cid", clientSecret: "csecret", fetchImpl });

    await connector.search({ query: "a", max: 10, filters: {} });
    await connector.search({ query: "b", max: 10, filters: {} });

    const tokenCalls = calls.filter((c) => c.url.includes("/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("drops items with no itemId rather than throwing", async () => {
    const { fetchImpl } = stubFetch();
    const connector = makeEbayConnector({ clientId: "cid", clientSecret: "csecret", fetchImpl });
    const obs = await connector.search({ query: "x", max: 10, filters: {} });
    expect(obs.every((o) => o.ref.external_id !== "undefined")).toBe(true);
  });
});
