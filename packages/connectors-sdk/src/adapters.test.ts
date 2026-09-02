import { describe, it, expect } from "vitest";
import type { ConnectorPolicy } from "@opportunity-os/contracts";
import { isAutomationPermitted, makeHttpApiConnector, makeCrawlConnector } from "./adapters";

const apiPolicy: ConnectorPolicy = { automation: "official_api", respects_robots: true, allowed_categories: [] };

function stubFetch(payload: { json?: unknown; text?: string }): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    async json() {
      return payload.json;
    },
    async text() {
      return payload.text ?? "";
    },
  })) as unknown as typeof fetch;
}

describe("isAutomationPermitted", () => {
  it("permits API/feed/authorized and robots-respecting public fetch; rejects manual + non-robots crawl", () => {
    expect(isAutomationPermitted(apiPolicy)).toBe(true);
    expect(isAutomationPermitted({ automation: "manual_human_assisted", respects_robots: true, allowed_categories: [] })).toBe(false);
    expect(isAutomationPermitted({ automation: "permitted_public_fetch", respects_robots: false, allowed_categories: [] })).toBe(false);
    expect(isAutomationPermitted({ automation: "permitted_public_fetch", respects_robots: true, allowed_categories: [] })).toBe(true);
  });
});

describe("makeHttpApiConnector", () => {
  it("maps API JSON into observations tagged with the connector + automation", async () => {
    const connector = makeHttpApiConnector({
      id: "test-api",
      capabilities: ["supply"],
      policy: apiPolicy,
      fetchImpl: stubFetch({ json: { items: [{ id: "sku1", title: "Widget", price: 1000 }] } }),
      buildRequest: (input) => ({ url: `https://api.test/search?q=${encodeURIComponent(input.query)}` }),
      mapResponse: (json) => {
        if (!json || typeof json !== "object" || !("items" in json) || !Array.isArray(json.items)) return [];
        return json.items.map((x) => ({
          kind: "supply" as const,
          externalId: String(x.id),
          content: { title: x.title, price: x.price, category: "electronics" },
        }));
      },
    });
    const obs = await connector.search({ query: "widget", max: 25, filters: {} });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.ref.source_id).toBe("test-api");
    expect(obs[0]!.kind).toBe("supply");
    expect(obs[0]!.automation).toBe("official_api");
    expect(obs[0]!.content_hash).toHaveLength(64);
  });
});

describe("makeCrawlConnector", () => {
  it("parses fetched text into observations tagged permitted_public_fetch", async () => {
    const connector = makeCrawlConnector({
      id: "test-crawl",
      capabilities: ["supply"],
      policy: { automation: "permitted_public_fetch", respects_robots: true, allowed_categories: [] },
      fetchImpl: stubFetch({ text: "sku9|Chair|4200" }),
      buildRequest: () => ({ url: "https://site.test/list" }),
      parse: (body) =>
        body
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [id, title, price] = line.split("|");
            return { kind: "supply" as const, externalId: id ?? "", content: { title, price: Number(price), category: "furniture" } };
          }),
    });
    const obs = await connector.search({ query: "", max: 25, filters: {} });
    expect(obs[0]!.ref.source_id).toBe("test-crawl");
    expect(obs[0]!.automation).toBe("permitted_public_fetch");
  });
});
