import { describe, it, expect } from "vitest";
import { buyerQueries, compsQuery, judgeDeal, median, type Comparable } from "./deals";

const comps = (...dollars: number[]): Comparable[] => dollars.map((d, i) => ({ title: `c${i}`, url: null, priceMinor: d * 100, currency: "USD" }));

describe("good-deal screen", () => {
  it("builds a comparables search from the meaningful words of a title", () => {
    expect(compsQuery("DeWalt 20V MAX drill set - like NEW, pickup only!!")).toBe("dewalt 20v max drill");
    expect(compsQuery("Must sell OBO")).toBeNull();
    expect(buyerQueries("dewalt 20v max drill")).toEqual(["wanted dewalt 20v max drill", "buying dewalt 20v max drill in bulk"]);
  });

  it("calls a deal good only well under the trimmed median of enough comparables", () => {
    const market = comps(90, 100, 100, 110, 120, 95, 105, 2, 900, 100);
    expect(median([3, 1, 2])).toBe(2);
    expect(judgeDeal(6000, "USD", market, { minDiscount: 0.3, demandMatch: false })).toMatchObject({ verdict: "good_deal", medianMinor: 10000, discount: 0.4 });
    // Priced 250x the median: still overpriced, with a discount the deal_checks column can hold.
    expect(judgeDeal(2_500_000, "USD", market, { minDiscount: 0.3, demandMatch: false })).toMatchObject({ verdict: "overpriced", discount: -99.9999 });
    expect(judgeDeal(8500, "USD", market, { minDiscount: 0.3, demandMatch: false }).verdict).toBe("fair");
    // A buyer asked for it: half the bar.
    expect(judgeDeal(8500, "USD", market, { minDiscount: 0.3, demandMatch: true }).verdict).toBe("good_deal");
    expect(judgeDeal(15000, "USD", market, { minDiscount: 0.3, demandMatch: false }).verdict).toBe("overpriced");
  });

  it("does not guess without enough comparables in the same currency, or without a price", () => {
    expect(judgeDeal(5000, "USD", comps(100, 100, 100, 100), { minDiscount: 0.3, demandMatch: false }).verdict).toBe("no_comps");
    expect(judgeDeal(5000, "CAD", comps(100, 100, 100, 100, 100, 100), { minDiscount: 0.3, demandMatch: false }).verdict).toBe("no_comps");
    expect(judgeDeal(null, "USD", comps(100, 100, 100, 100, 100), { minDiscount: 0.3, demandMatch: false }).verdict).toBe("no_price");
  });
});
