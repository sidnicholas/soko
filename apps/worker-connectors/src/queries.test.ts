import { describe, it, expect } from "vitest";
import type { DemandSpecification } from "@opportunity-os/contracts";
import { searchQueries, searchQueryFromDescription } from "./queries";

const mission = (description: string) => ({ demandSpec: { what: { description } } as DemandSpecification });

describe("searchQueryFromDescription", () => {
  it("keeps item words and drops filler, prices and timing", () => {
    expect(searchQueryFromDescription("Need a 27-inch 4K monitor under $220, delivered this week.")).toBe("27-inch 4k monitor");
    expect(searchQueryFromDescription("Looking for a used Fender Stratocaster, budget $800")).toBe("fender stratocaster");
  });

  it("caps the number of terms", () => {
    expect(searchQueryFromDescription("sony wh1000xm5 wireless noise cancelling headphones black edition").split(" ")).toHaveLength(5);
  });

  it("returns empty when nothing item-like remains", () => {
    expect(searchQueryFromDescription("need it asap under $50")).toBe("");
    expect(searchQueryFromDescription("$50")).toBe("");
  });
});

describe("searchQueries", () => {
  it("derives one deduplicated query per mission, capped", () => {
    const missions = [mission("Need a 4K monitor"), mission("want a 4k monitor!"), mission("Fender amp")];
    expect(searchQueries(missions, "electronics")).toEqual(["4k monitor", "fender amp"]);
    expect(searchQueries(missions, "electronics", 1)).toEqual(["4k monitor"]);
  });

  it("falls back to the seed when no mission yields a query", () => {
    expect(searchQueries([], "electronics")).toEqual(["electronics"]);
    expect(searchQueries([mission("$50")], "electronics")).toEqual(["electronics"]);
  });
});
