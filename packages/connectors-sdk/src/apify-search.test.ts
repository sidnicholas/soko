import { describe, it, expect } from "vitest";
import { parseSearchPlan, planSearches, runInput, searchKey, searchTerm, type ApifySearchPlan, type SearchHistory } from "./apify-search";

const PLAN: ApifySearchPlan = {
  urlTemplate: "https://www.facebook.com/marketplace/{city}/search/?query={query}",
  cities: ["detroit"],
  queries: ["pallet tools", "contractor surplus", "lot of appliances", "drywall"],
  fromDemand: true,
  perRun: 5,
  searchUrlField: "facebookUrl",
};
const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("planSearches", () => {
  it("puts buyer demand first (up to 60% of the run), then the list, never searched first", () => {
    const out = planSearches(PLAN, ["Office chairs", "office chairs", "\"site:ebay.com\" forklift", "steel shelving", "x"], new Map(), NOW);
    expect(out.map((s) => [s.origin, s.term])).toEqual([
      ["demand", "office chairs"],
      ["demand", "forklift"],
      ["demand", "steel shelving"],
      ["list", "pallet tools"],
      ["list", "contractor surplus"],
    ]);
    expect(out[0]!.url).toBe("https://www.facebook.com/marketplace/detroit/search/?query=office%20chairs");
  });

  it("skips what ran in the last day, rotates the rest oldest first, and drops barren searches for a week", () => {
    const h = new Map<string, SearchHistory>([
      [searchKey("pallet tools", "detroit"), { lastAt: ago(2), recentNew: [4] }],
      [searchKey("contractor surplus", "detroit"), { lastAt: ago(30), recentNew: [0, 0, 0] }],
      [searchKey("lot of appliances", "detroit"), { lastAt: ago(48), recentNew: [1] }],
      [searchKey("drywall", "detroit"), { lastAt: ago(26), recentNew: [0, 2] }],
    ]);
    const out = planSearches({ ...PLAN, fromDemand: false }, [], h, NOW);
    expect(out.map((s) => s.term)).toEqual(["lot of appliances", "drywall"]);
    // A barren search comes back after a week, after the others.
    h.set(searchKey("contractor surplus", "detroit"), { lastAt: ago(24 * 8), recentNew: [0, 0, 0] });
    expect(planSearches({ ...PLAN, fromDemand: false }, [], h, NOW).map((s) => s.term)).toEqual(["lot of appliances", "drywall", "contractor surplus"]);
  });

  it("searches every city and fills the run with demand when there is no list", () => {
    const out = planSearches({ ...PLAN, cities: ["detroit", "chicago"], queries: [], perRun: 3 }, ["generators", "pallet racking"], new Map(), NOW);
    expect(out.map((s) => `${s.term}@${s.city}`)).toEqual(["generators@detroit", "generators@chicago", "pallet racking@detroit"]);
  });
});

describe("runInput and parsing", () => {
  it("puts the planned URLs into the fixed input", () => {
    const searches = planSearches({ ...PLAN, fromDemand: false, perRun: 2 }, [], new Map(), NOW);
    expect(runInput({ includeListingDetails: true, startUrls: [{ url: "old" }] }, PLAN, searches)).toEqual({
      includeListingDetails: true,
      startUrls: [{ url: "https://www.facebook.com/marketplace/detroit/search/?query=pallet%20tools" }, { url: "https://www.facebook.com/marketplace/detroit/search/?query=contractor%20surplus" }],
    });
  });

  it("validates plans", () => {
    expect("plan" in parseSearchPlan(PLAN)).toBe(true);
    expect(parseSearchPlan({ urlTemplate: "http://x.com/?q={query}", cities: ["Detroit MI"], queries: [], fromDemand: false, perRun: 50 })).toEqual({
      errors: ["urlTemplate must be an https URL containing {query}", "cities must be URL slugs like detroit or newyork", "give queries, or set fromDemand", "perRun must be 1–20"],
    });
    expect(parseSearchPlan({ urlTemplate: "https://x.com/{city}?q={query}", fromDemand: true })).toEqual({ errors: ["cities are required when urlTemplate has {city}"] });
    expect(searchTerm("  \"Industrial\" (shelving) intitle:sale ")).toBe("industrial shelving");
  });
});
