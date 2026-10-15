import { describe, it, expect } from "vitest";
import { WindowRateLimiter } from "./rate-limit";

describe("WindowRateLimiter", () => {
  it("allows up to the limit per key per window, then resets", () => {
    let t = 0;
    const limiter = new WindowRateLimiter(2, 1000, () => t);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, false]);
    expect(limiter.allow("b")).toBe(true); // keys are independent
    t = 1000;
    expect(limiter.allow("a")).toBe(true);
  });

  it("stays bounded under many distinct keys", () => {
    let t = 0;
    const limiter = new WindowRateLimiter(1, 1000, () => t, 3);
    for (const k of ["a", "b", "c"]) limiter.allow(k);
    t = 2000;
    expect(limiter.allow("d")).toBe(true); // sweeps the expired a, b, c
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
  });

  it("a limit of zero refuses everything", () => {
    expect(new WindowRateLimiter(0, 1000).allow("a")).toBe(false);
  });
});
