import { describe, it, expect } from "vitest";
import { decideRelease, type ReleaseContext } from "./release";

const base: ReleaseContext = {
  humanReleasePolicy: "over_threshold",
  amountMinor: 5000,
  thresholdMinor: 100000,
  conditionSatisfied: true,
  disputed: false,
  now: new Date("2026-09-01T12:00:00Z"),
};

describe("decideRelease", () => {
  it("holds a disputed milestone above all else", () => {
    expect(decideRelease({ ...base, disputed: true }).decision).toBe("hold");
  });

  it("auto-refunds after the deadman deadline when conditions are unmet", () => {
    const out = decideRelease({
      ...base,
      conditionSatisfied: false,
      deadmanAtIso: "2026-08-01T00:00:00Z",
    });
    expect(out.decision).toBe("auto_refund");
    expect(out.reason).toBe("deadman_timeout");
  });

  it("holds when conditions unmet and no optimistic window", () => {
    expect(decideRelease({ ...base, conditionSatisfied: false }).decision).toBe("hold");
  });

  it("auto-releases below threshold, requires approval at/above threshold", () => {
    expect(decideRelease({ ...base, amountMinor: 5000 }).decision).toBe("auto_release");
    expect(decideRelease({ ...base, amountMinor: 100000 }).decision).toBe("require_approval");
  });

  it("policy always always requires approval; never never does", () => {
    expect(decideRelease({ ...base, humanReleasePolicy: "always", amountMinor: 1 }).decision).toBe("require_approval");
    expect(decideRelease({ ...base, humanReleasePolicy: "never", amountMinor: 10_000_000 }).decision).toBe("auto_release");
  });

  it("optimistic window makes an unmet milestone releasable", () => {
    const out = decideRelease({
      ...base,
      conditionSatisfied: false,
      amountMinor: 5000,
      optimisticAfterIso: "2026-08-01T00:00:00Z",
    });
    expect(out.decision).toBe("auto_release");
    expect(out.optimistic).toBe(true);
    expect(out.reason).toBe("optimistic_window");
  });
});
