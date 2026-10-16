import { describe, it, expect } from "vitest";
import { completeCosts, dealEconomics, rankDeals, tierFor, type DealEconomicsInput } from "./deal-economics";

const NO_CAP = { maxCapitalUsd: 1_000_000 };

describe("dealEconomics (PRD v2 FR-04)", () => {
  it("does not rank a $100,000 headline spread with $110,000 landed costs as profitable (PRD v2 §15)", () => {
    const e = dealEconomics(
      {
        mode: "principal",
        grossRevenueUsd: [300_000, 300_000],
        userRevenueUsd: [300_000, 300_000],
        costLines: [
          { kind: "purchase", usd: [200_000, 200_000], label: "source_fact" },
          { kind: "freight", usd: [60_000, 60_000], label: "estimate" },
          { kind: "duties", usd: [40_000, 40_000], label: "estimate" },
          { kind: "insurance", usd: [10_000, 10_000], label: "estimate" },
        ],
        capitalRequiredUsd: 0,
        probability: [0.5, 0.5],
        daysToCash: [30, 30],
      },
      NO_CAP,
    );
    expect(e.grossSpreadUsd).toEqual([100_000, 100_000]);
    expect(e.netProfitUsd[1]).toBeLessThan(0);
    expect(e.tier).toBe("negative");
    expect(e.gates).toContain("negative_net_economics");
  });

  it("fills unstated costs from labelled assumptions, per mode", () => {
    const base: DealEconomicsInput = { mode: "brokerage", grossRevenueUsd: null, userRevenueUsd: [1000, 1000], costLines: [], capitalRequiredUsd: 0, probability: [0.2, 0.4], daysToCash: [10, 20] };
    expect(completeCosts(base).map((c) => [c.kind, c.label])).toEqual([["payment_fees", "default_assumption"]]);
    const principal = completeCosts({ ...base, mode: "principal", capitalRequiredUsd: 3650, crossCurrency: true });
    expect(principal.map((c) => c.kind).sort()).toEqual(["chargebacks", "financing", "freight", "fx", "payment_fees", "returns"]);
    // 12% a year on $3,650 is $1.20 a day, for 10–20 days.
    expect(principal.find((c) => c.kind === "financing")!.usd).toEqual([12, 24]);
    // A stated line is never replaced by an assumption.
    const stated = completeCosts({ ...base, mode: "principal", costLines: [{ kind: "freight", usd: [40, 50], label: "source_fact" }] });
    expect(stated.filter((c) => c.kind === "freight")).toEqual([{ kind: "freight", usd: [40, 50], label: "source_fact" }]);
  });

  it("keeps revenue, spread, net, capital, probability-adjusted profit and time to cash separate", () => {
    const e = dealEconomics(
      { mode: "brokerage", grossRevenueUsd: [8000, 10000], userRevenueUsd: [400, 600], costLines: [{ kind: "other", usd: [0, 50], label: "estimate" }], capitalRequiredUsd: 0, probability: [0.2, 0.4], daysToCash: null },
      NO_CAP,
    );
    expect(e.grossRevenueUsd).toEqual([8000, 10000]);
    expect(e.grossSpreadUsd).toEqual([400, 600]);
    // Fees 2–3.5% of $400–600: $8–21. Net low = 400 − 50 − 21 = 329; high = 600 − 0 − 8 = 592.
    expect(e.netProfitUsd).toEqual([329, 592]);
    expect(e.expectedProfitUsd).toEqual([65.8, 236.8]);
    expect(e.daysToCash).toEqual([14, 60]);
    expect(e.tier).toBe("medium");
    expect(e.gates).toEqual([]);
  });

  it("gates capital above the per-deal exposure limit without discarding the deal", () => {
    const e = dealEconomics({ mode: "principal", grossRevenueUsd: null, userRevenueUsd: [5000, 5000], costLines: [{ kind: "purchase", usd: [3000, 3000], label: "source_fact" }], capitalRequiredUsd: 3000, probability: [0.5, 0.5], daysToCash: [10, 10] }, { maxCapitalUsd: 1000 });
    expect(e.gates).toEqual(["capital_exposure"]);
    expect(e.tier).not.toBe("negative");
  });

  it("tiers on the middle of the net range", () => {
    expect([tierFor([900, 1200]), tierFor([200, 400]), tierFor([40, 80]), tierFor([-10, 30]), tierFor([-50, 40])]).toEqual(["high", "medium", "low", "marginal", "negative"]);
  });
});

describe("rankDeals (PRD v2 §2: profit, then probability, then time to close)", () => {
  const deal = (id: string, net: [number, number], p: [number, number], days: [number, number], capital = 0) => ({
    id,
    e: dealEconomics({ mode: "brokerage", grossRevenueUsd: null, userRevenueUsd: net, costLines: [{ kind: "payment_fees", usd: [0, 0], label: "estimate" }], capitalRequiredUsd: capital, probability: p, daysToCash: days }, { maxCapitalUsd: 1000 }),
  });
  const deals = [
    deal("small-sure-fast", [60, 80], [0.9, 0.9], [2, 3]),
    deal("big-unsure", [2000, 3000], [0.1, 0.2], [30, 60]),
    deal("big-likely", [1500, 2500], [0.5, 0.6], [40, 60]),
    deal("loss", [-500, -100], [0.9, 0.9], [1, 2]),
    deal("over-exposed", [5000, 6000], [0.9, 0.9], [5, 5], 50_000),
  ];

  it("profit_first: tier, then probability, then time; gated last", () => {
    const ranked = rankDeals(deals, (d) => d.e).map((d) => d.id);
    expect(ranked.slice(0, 3)).toEqual(["big-likely", "big-unsure", "small-sure-fast"]);
    expect(new Set(ranked.slice(3))).toEqual(new Set(["loss", "over-exposed"]));
  });

  it("expected_value and fastest_cash reorder the viable deals; gated ones still trail", () => {
    expect(rankDeals(deals, (d) => d.e, "expected_value").slice(0, 3).map((d) => d.id)).toEqual(["big-likely", "big-unsure", "small-sure-fast"]);
    // Cash in ~2.5, ~45 and ~50 days.
    expect(rankDeals(deals, (d) => d.e, "fastest_cash").slice(0, 3).map((d) => d.id)).toEqual(["small-sure-fast", "big-unsure", "big-likely"]);
  });
});
