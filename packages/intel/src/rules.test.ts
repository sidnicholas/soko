import { describe, it, expect } from "vitest";
import {
  bucketFor,
  expectedValue,
  fraudFlags,
  freshnessScore,
  monetizationResolved,
  regulatoryFlags,
  scoreCandidate,
  verificationStatus,
  type ContactPath,
  type ScoreInput,
} from "./rules";
import { stageOnePool, stageOneQueries } from "./queries";
import { runAllowanceUsd } from "./run";

const NOW = new Date("2026-10-03T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const sourceContact: ContactPath = { channel: "marketplace_message", value: null, label: "source_fact" };

describe("freshnessScore", () => {
  it("halves per half-life, faster for urgent needs", () => {
    expect(freshnessScore(daysAgo(0), "high", NOW)).toBe(1);
    expect(freshnessScore(daysAgo(3), "high", NOW)).toBe(0.5);
    expect(freshnessScore(daysAgo(14), "medium", NOW)).toBe(0.5);
    expect(freshnessScore(daysAgo(90), "low", NOW)).toBeLessThan(0.3);
  });
  it("treats an unknown date as moderately stale", () => {
    expect(freshnessScore(null, "high", NOW)).toBe(0.4);
  });
});

describe("verificationStatus", () => {
  const base = { publishedAt: daysAgo(1), freshness: 0.9, contact: sourceContact, counterpartyFound: true };
  it("needs checkable facts before calling anything verified", () => {
    expect(verificationStatus({ ...base, evidence: "verified" })).toBe("verified");
    expect(verificationStatus({ ...base, evidence: "verified", publishedAt: null })).toBe("plausible");
    expect(verificationStatus({ ...base, evidence: "verified", contact: { ...sourceContact, label: "inference" } })).toBe("strongly_supported");
  });
  it("never rises above speculative without an opposite side, and rejects no-evidence", () => {
    expect(verificationStatus({ ...base, evidence: "verified", counterpartyFound: false })).toBe("speculative");
    expect(verificationStatus({ ...base, evidence: "none" })).toBe("rejected");
  });
});

describe("screening", () => {
  it("flags licensing and scam patterns", () => {
    expect(regulatoryFlags("Need carrier capacity for 3 truckload shipments").map((f) => f.flag)).toContain("freight_broker_authority");
    expect(regulatoryFlags("Selling surplus pallet racking")).toEqual([]);
    expect(fraudFlags("Payment by gift cards only, wire transfer only").map((f) => f.flag)).toEqual(["unusual_payment", "gift_card_payment"]);
  });
});

describe("why-paid test and expected value", () => {
  it("requires payer, mechanism and value-add", () => {
    expect(monetizationResolved({ payer: "Shop owner", mechanism: "fixed_service_fee", timing: "on completion", valueAdded: "fix tracking" })).toBe(true);
    expect(monetizationResolved({ payer: null, mechanism: "commission", timing: null, valueAdded: "intro" })).toBe(false);
  });
  it("is zero when monetization is unresolved, and a decayed range otherwise", () => {
    expect(expectedValue({ compensationUsd: [500, 1000], probability: [0.2, 0.4], freshness: 1, resolved: false, fraud: false })).toEqual([0, 0]);
    expect(expectedValue({ compensationUsd: [1000, 500], probability: [0.4, 0.2], freshness: 0.5, resolved: true, fraud: false })).toEqual([50, 200]);
    expect(expectedValue({ compensationUsd: [500, 1000], probability: [0.2, 0.4], freshness: 1, resolved: true, fraud: true })).toEqual([30, 120]);
  });
});

describe("score and bucket", () => {
  const strong: ScoreInput = {
    ev: [150, 600],
    verification: "strongly_supported",
    freshness: 0.8,
    contact: sourceContact,
    resolved: true,
    capitalUsd: 0,
    timeHours: [4, 12],
    regulatory: [],
    fraud: [],
  };

  it("explains every point", () => {
    const { score, factors } = scoreCandidate(strong);
    expect(factors.map((f) => f.name)).toEqual(["expected_value", "evidence", "freshness", "contactability", "monetization", "speed_and_capital", "regulatory", "fraud"]);
    expect(score).toBeCloseTo(factors.reduce((s, f) => s + f.points, 0), 1);
    expect(score).toBeGreaterThan(60);
  });

  it("puts only resolved, reachable, fresh, clean, low-capital candidates in ACT NOW", () => {
    expect(bucketFor({ ...strong, compensationHighUsd: 1000 })).toEqual({ bucket: "act_now", rejectReason: null });
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, resolved: false }).bucket).toBe("watch");
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, capitalUsd: 5000 }).bucket).toBe("verify_next");
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, regulatory: [{ flag: "real_estate_license", reason: "" }] }).bucket).toBe("verify_next");
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, contact: null }).bucket).toBe("watch");
  });

  it("rejects with reason codes", () => {
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, freshness: 0.05 })).toEqual({ bucket: "rejected", rejectReason: "stale" });
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, verification: "rejected" }).rejectReason).toBe("not_credible");
    const twoFraud = [{ flag: "a", reason: "" }, { flag: "b", reason: "" }];
    expect(bucketFor({ ...strong, compensationHighUsd: 1000, fraud: twoFraud }).rejectReason).toBe("fraud_risk");
    expect(bucketFor({ ...strong, compensationHighUsd: 0 }).rejectReason).toBe("no_value_path");
  });
});

describe("stage-one queries", () => {
  it("samples every orientation each run and rotates across runs", () => {
    const run0 = stageOneQueries(0, 6);
    const run1 = stageOneQueries(1, 6);
    expect(run0).toHaveLength(6);
    expect(new Set(run0.map((q) => q.orientation))).toEqual(new Set(["demand", "supply", "problem"]));
    expect(run0.map((q) => q.query)).not.toEqual(run1.map((q) => q.query));
    expect(new Set(run0.map((q) => q.query)).size).toBe(6);
  });
  it("cycles through every query in every lane, whatever the lane sizes", () => {
    const pool = stageOnePool();
    const seen = new Set<string>();
    for (let run = 0; run < 12; run++) for (const q of stageOneQueries(run, 8)) seen.add(q.query);
    expect(seen.size).toBe(pool.length);
    // Consecutive runs don't repeat the same demand queries (regression: lane size == count).
    const demand = (run: number) => stageOneQueries(run, 8).filter((q) => q.orientation === "demand").map((q) => q.query);
    expect(demand(0)).not.toEqual(demand(1));
  });
  it("pins every query to a venue with a host-level site filter", () => {
    for (const q of stageOnePool()) expect(q.query).toMatch(/^site:[a-z0-9.-]+\s/);
  });
  it("never asks for more queries than the pool holds", () => {
    expect(stageOneQueries(0, 999)).toHaveLength(stageOnePool().length);
  });
});

describe("runAllowanceUsd", () => {
  const day = { dailyBudgetUsd: 1, runsPerDay: 4 };
  it("gives each run its share, rolling unused allowance forward", () => {
    expect(runAllowanceUsd({ ...day, spentTodayUsd: 0, runsStartedToday: 0 })).toBe(0.25);
    // Run 1 spent only $0.10: run 2 may spend 2 × 0.25 − 0.10.
    expect(runAllowanceUsd({ ...day, spentTodayUsd: 0.1, runsStartedToday: 1 })).toBeCloseTo(0.4);
    // Run 1 overspent its share: run 2 gets only what keeps the pace.
    expect(runAllowanceUsd({ ...day, spentTodayUsd: 0.45, runsStartedToday: 1 })).toBeCloseTo(0.05);
  });
  it("never exceeds what is left of the daily cap, and never goes negative", () => {
    expect(runAllowanceUsd({ ...day, spentTodayUsd: 0.9, runsStartedToday: 7 })).toBeCloseTo(0.1);
    expect(runAllowanceUsd({ ...day, spentTodayUsd: 1.2, runsStartedToday: 2 })).toBe(0);
  });
});
