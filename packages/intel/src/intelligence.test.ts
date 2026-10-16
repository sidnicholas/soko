import { describe, it, expect } from "vitest";
import { capForEvidence, counterpartOutcome, hypothesisSchedule, laneKinds, routeSignal, titleFlags } from "./intelligence";
import { DetectionSchema } from "./prompts";

describe("lanes", () => {
  it("demand covers demand and problems, supply covers supply", () => {
    expect(laneKinds("demand")).toEqual(["demand", "problem"]);
    expect(laneKinds("supply")).toEqual(["supply"]);
    expect(laneKinds("all")).toEqual(["demand", "supply", "problem"]);
  });
});

describe("routeSignal (PRD v2 §15: a demand precursor is never a confirmed buyer)", () => {
  it("sends inferred demand and problems to the watchlist, keeps inferred supply as a lead", () => {
    expect(routeSignal("demand", "inferred")).toBe("hypothesis");
    expect(routeSignal("problem", "inferred")).toBe("hypothesis");
    expect(routeSignal("demand", "observed")).toBe("lead");
    expect(routeSignal("supply", "inferred")).toBe("lead");
  });
});

describe("titleFlags (FR-02: liquidation does not mean clear title)", () => {
  const supply = { kind: "supply" as const, signalType: null, titleUnverified: false, text: "Pallets of mixed stock" };
  it("flags liquidation, distressed stock and the model's own flag", () => {
    expect(titleFlags({ ...supply, signalType: "liquidation" })[0]?.flag).toBe("title_unverified");
    expect(titleFlags({ ...supply, titleUnverified: true })).toHaveLength(1);
    expect(titleFlags({ ...supply, text: "Warehouse going out of business, everything must go" })).toHaveLength(1);
    expect(titleFlags({ ...supply, text: "Bankruptcy auction of CNC machines" })).toHaveLength(1);
  });
  it("leaves ordinary listings and non-supply leads alone", () => {
    expect(titleFlags(supply)).toEqual([]);
    expect(titleFlags({ ...supply, kind: "demand", signalType: "liquidation" })).toEqual([]);
  });
});

describe("capForEvidence (FR-03: evidence before outbound claims)", () => {
  it("caps inferred signals at WATCH with no outreach", () => {
    expect(capForEvidence("supply", "inferred", { bucket: "act_now", rejectReason: null })).toEqual({ bucket: "watch", rejectReason: "surplus_inferred", suppressOutreach: true });
    expect(capForEvidence("demand", "inferred", { bucket: "verify_next", rejectReason: null })).toEqual({ bucket: "watch", rejectReason: "intent_inferred", suppressOutreach: true });
    expect(capForEvidence("supply", "inferred", { bucket: "rejected", rejectReason: "stale" })).toEqual({ bucket: "rejected", rejectReason: "stale", suppressOutreach: true });
    // Already WATCH for another reason: the inferred label comes first.
    expect(capForEvidence("supply", "inferred", { bucket: "watch", rejectReason: null })).toEqual({ bucket: "watch", rejectReason: "surplus_inferred", suppressOutreach: true });
  });
  it("passes observed signals through", () => {
    expect(capForEvidence("demand", "observed", { bucket: "act_now", rejectReason: null })).toEqual({ bucket: "act_now", rejectReason: null, suppressOutreach: false });
  });
});

describe("counterpartOutcome", () => {
  const now = new Date("2026-10-16T00:00:00Z");
  it("is found with any result, otherwise retries once after three days", () => {
    expect(counterpartOutcome(2, 0, now)).toEqual({ status: "found", nextAt: null, attempts: 1 });
    expect(counterpartOutcome(0, 0, now)).toEqual({ status: "none_found", nextAt: "2026-10-19T00:00:00.000Z", attempts: 1 });
    expect(counterpartOutcome(0, 1, now)).toEqual({ status: "none_found", nextAt: null, attempts: 2 });
  });
});

describe("hypothesisSchedule", () => {
  const now = new Date("2026-10-16T00:00:00Z");
  it("revisits on its interval and expires after four, within 30 to 90 days", () => {
    expect(hypothesisSchedule(14, now)).toEqual({ revisitAt: "2026-10-30T00:00:00.000Z", expiresAt: "2026-12-11T00:00:00.000Z" });
    expect(hypothesisSchedule(1, now)).toEqual({ revisitAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-11-15T00:00:00.000Z" });
    expect(hypothesisSchedule(60, now).expiresAt).toBe("2027-01-14T00:00:00.000Z");
  });
});

describe("detection parse defaults", () => {
  it("treats a lead without an evidence level as inferred, and accepts a reply without hypotheses", () => {
    const parsed = DetectionSchema.parse({
      skipped: [],
      leads: [{ index: 0, kind: "demand", title: "t", summary: "s", urgency: "high", credibility: 0.8, contact: null, facts: [], opposite_queries: [] }],
    });
    expect(parsed.leads[0]).toMatchObject({ evidence_level: "inferred", signal_type: "other", title_unverified: false, supply_terms: { moq: null } });
    expect(parsed.hypotheses).toEqual([]);
  });
});
