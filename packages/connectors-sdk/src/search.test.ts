import { describe, it, expect } from "vitest";
import { makeBraveSearch, makeSerperSearch, makeYouSearch, serperPublishedAt } from "./search";

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

describe("makeSerperSearch", () => {
  const now = () => new Date("2026-10-15T12:00:00Z");

  it("posts the query with the key header and maps results, dates included", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            organic: [
              { title: "WTB: used forklift", link: "https://www.example.com/wtb", snippet: "Looking for a 5,000 lb forklift", date: "3 days ago" },
              { title: "Absolute date", link: "https://forum.example.org/t/1", snippet: "s", date: "Sep 29, 2026" },
              { title: "No date", link: "https://example.net/x", snippet: "s" },
              { title: "no link, dropped" },
            ],
          };
        },
      } as Response;
    }) as unknown as typeof fetch;

    const provider = makeSerperSearch({ apiKey: "k", fetchImpl, now });
    const results = await provider.search({ query: "site:reddit.com WTB forklift", count: 20, freshness: "month" });

    expect(provider.costPerQueryUsd).toBe(0.001);
    expect(calls[0]!.url).toBe("https://google.serper.dev/search");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ q: "site:reddit.com WTB forklift", num: 10, tbs: "qdr:m" });
    expect(results.map((r) => [r.hostname, r.publishedAt, r.provider])).toEqual([
      ["example.com", "2026-10-12T12:00:00.000Z", "serper"],
      ["forum.example.org", new Date("Sep 29, 2026").toISOString(), "serper"],
      ["example.net", null, "serper"],
    ]);
  });

  it("throws on a provider error so the caller can log and skip", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
    await expect(makeSerperSearch({ apiKey: "k", fetchImpl }).search({ query: "x" })).rejects.toThrow("serper search 403");
  });

  it("reads relative and absolute dates, and leaves unknown ones null", () => {
    expect(serperPublishedAt("1 hour ago", now())).toBe("2026-10-15T11:00:00.000Z");
    expect(serperPublishedAt("2 weeks ago", now())).toBe("2026-10-01T12:00:00.000Z");
    expect(serperPublishedAt("sometime", now())).toBeNull();
    expect(serperPublishedAt(undefined, now())).toBeNull();
  });
});

describe("makeYouSearch", () => {
  it("posts to You.com with the key header and maps web results", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            results: {
              web: [
                { url: "https://www.ec21.com/buy/drills", title: " Buying drills ", description: "Need 500 drills", page_age: "2026-10-20T08:00:00" },
                { url: "https://b.example/x", title: "B", snippets: ["only a snippet"] },
                { title: "no url" },
              ],
            },
          };
        },
      } as Response;
    }) as unknown as typeof fetch;
    const search = makeYouSearch({ apiKey: "ydc", fetchImpl });
    const out = await search.search({ query: "site:ec21.com drills", count: 50, freshness: "week" });

    expect(calls[0]!.url).toBe("https://ydc-index.io/v1/search");
    expect((calls[0]!.init?.headers as Record<string, string>)["x-api-key"]).toBe("ydc");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ query: "site:ec21.com drills", count: 20, freshness: "week" });
    expect(search.costPerQueryUsd).toBe(0.005);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ url: "https://www.ec21.com/buy/drills", title: "Buying drills", snippet: "Need 500 drills", hostname: "ec21.com", provider: "youcom" });
    expect(out[0]!.publishedAt).toMatch(/^2026-10-20/);
    expect(out[1]).toMatchObject({ snippet: "only a snippet", publishedAt: null });
  });

  it("throws on an HTTP error", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401 }) as Response) as unknown as typeof fetch;
    await expect(makeYouSearch({ apiKey: "bad", fetchImpl }).search({ query: "q" })).rejects.toThrow("youcom search 401");
  });
});
