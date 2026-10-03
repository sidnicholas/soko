import { describe, it, expect } from "vitest";
import { makeReverbConnector } from "./reverb";

function stubFetch(body: unknown): { fetchImpl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return body; } } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const LISTINGS = {
  total: 2,
  listings: [
    {
      id: 84598461,
      title: "Fender Player Stratocaster",
      description: "<p>Great&nbsp;condition,</p><br/>barely played",
      condition: { display_name: "Excellent" },
      price: { amount: "649.99", amount_cents: 64999, currency: "USD" },
      categories: [{ full_name: "Electric Guitars / Solid Body" }],
      _links: { web: { href: "https://reverb.com/item/84598461-fender-player-stratocaster" } },
    },
    { title: "no id, dropped" },
  ],
};

describe("makeReverbConnector", () => {
  it("searches keyless and maps listings to supply observations", async () => {
    const { fetchImpl, calls } = stubFetch(LISTINGS);
    const obs = await makeReverbConnector({ fetchImpl }).search({ query: "stratocaster", max: 10, filters: {} });

    expect(calls[0]!.url).toBe("https://api.reverb.com/api/listings?query=stratocaster&per_page=10");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["accept-version"]).toBe("3.0");
    expect(headers.authorization).toBeUndefined();

    expect(obs).toHaveLength(1);
    expect(obs[0]!.kind).toBe("supply");
    expect(obs[0]!.ref.external_id).toBe("84598461");
    expect(obs[0]!.ref.uri).toBe("https://reverb.com/item/84598461-fender-player-stratocaster");
    expect(obs[0]!.content).toMatchObject({
      title: "Fender Player Stratocaster",
      description: "Excellent — Electric Guitars / Solid Body — Great condition, barely played",
      category: "musical_instruments",
      price: 64999,
      currency: "USD",
    });
  });

  it("sends the optional token and caps page size at 50", async () => {
    const { fetchImpl, calls } = stubFetch({ listings: [] });
    await makeReverbConnector({ apiToken: "tok", fetchImpl }).search({ query: "amp", max: 200, filters: {} });
    expect(calls[0]!.url).toContain("per_page=50");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("tolerates an unexpected body", async () => {
    const { fetchImpl } = stubFetch({ error: "nope" });
    await expect(makeReverbConnector({ fetchImpl }).search({ query: "x", max: 5, filters: {} })).resolves.toEqual([]);
  });
});
