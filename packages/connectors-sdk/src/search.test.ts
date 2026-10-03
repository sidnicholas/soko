import { describe, it, expect } from "vitest";
import { makeBraveSearch } from "./search";

describe("makeBraveSearch", () => {
  it("queries Brave with the key header and maps results", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            web: {
              results: [
                {
                  url: "https://www.example.com/wtb-forklift",
                  title: "WTB: used <strong>forklift</strong>",
                  description: "Looking for a 5,000 lb forklift, cash &amp; pickup",
                  meta_url: { hostname: "www.example.com" },
                  page_age: "2026-10-01T12:00:00",
                  age: "2 days ago",
                },
                { title: "no url, dropped" },
              ],
            },
          };
        },
      } as Response;
    }) as unknown as typeof fetch;

    const results = await makeBraveSearch({ apiKey: "k", fetchImpl }).search({ query: "WTB forklift", count: 50, freshness: "week" });

    expect(calls[0]!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=WTB+forklift&count=20&freshness=pw");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-subscription-token"]).toBe("k");
    expect(results).toEqual([
      {
        url: "https://www.example.com/wtb-forklift",
        title: "WTB: used forklift",
        snippet: "Looking for a 5,000 lb forklift, cash & pickup",
        hostname: "example.com",
        publishedAt: new Date("2026-10-01T12:00:00").toISOString(),
        ageText: "2 days ago",
        provider: "brave",
      },
    ]);
  });

  it("throws on a provider error so the caller can log and skip", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch;
    await expect(makeBraveSearch({ apiKey: "k", fetchImpl }).search({ query: "x" })).rejects.toThrow("brave search 429");
  });
});
