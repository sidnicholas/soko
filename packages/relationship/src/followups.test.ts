import { describe, it, expect } from "vitest";
import { compareFollowUps, followUpPlan, type Touch } from "./followups";

const T0 = Date.parse("2026-10-01T15:00:00Z");
const at = (days: number) => new Date(T0 + days * 86_400_000);
const iso = (days: number) => at(days).toISOString();
const plan = (o: { status?: string; matchKind?: string; touches: Touch[]; now: number; snoozedUntil?: string | null }) =>
  followUpPlan({ status: o.status ?? "contacted", matchKind: o.matchKind ?? "supply_to_demand", statusChangedAt: iso(0), touches: o.touches, snoozedUntil: o.snoozedUntil ?? null, now: at(o.now) })!;

describe("follow-up cadence", () => {
  const first: Touch = { kind: "contacted", at: iso(0) };

  it("follows a listing up on days 1, 3 and 6, then lets it go cold", () => {
    expect(plan({ touches: [first], now: 0.5 })).toMatchObject({ stage: "upcoming", nextAt: iso(1), step: 2, of: 4, action: "Follow-up 1 of 3" });
    expect(plan({ touches: [first], now: 1 }).stage).toBe("due");
    const two = [first, { kind: "follow_up" as const, at: iso(1) }];
    expect(plan({ touches: two, now: 2 })).toMatchObject({ stage: "upcoming", nextAt: iso(3), action: "Follow-up 2 of 3" });
    const four = [...two, { kind: "follow_up" as const, at: iso(3) }, { kind: "follow_up" as const, at: iso(6) }];
    expect(plan({ touches: four, now: 8 })).toMatchObject({ stage: "upcoming", nextAt: iso(10), step: null });
    expect(plan({ touches: four, now: 10 })).toMatchObject({ stage: "cold", nextAt: null, action: "Gone cold" });
  });

  it("spaces business offers out over two weeks", () => {
    expect(plan({ matchKind: "problem_to_service", touches: [first], now: 0 }).nextAt).toBe(iso(3));
    const late = [first, { kind: "follow_up" as const, at: iso(6.5) }];
    // Due on day 7 by schedule, but at least a day after the late follow-up.
    expect(plan({ matchKind: "problem_to_service", touches: late, now: 7 })).toMatchObject({ stage: "upcoming", nextAt: iso(7.5) });
  });

  it("wants a next step within two days of a response and stalls after two weeks", () => {
    const responded: Touch[] = [first, { kind: "responded", at: iso(2) }];
    const p = (now: number) => followUpPlan({ status: "responded", matchKind: "supply_to_demand", statusChangedAt: iso(2), touches: responded, snoozedUntil: null, now: at(now) })!;
    expect(p(3)).toMatchObject({ stage: "upcoming", nextAt: iso(4), action: "Next step" });
    expect(p(4).stage).toBe("due");
    expect(p(16)).toMatchObject({ stage: "stalled", nextAt: null });
  });

  it("notes do not count as touches, and a snooze hides it until then", () => {
    expect(plan({ touches: [first, { kind: "note", at: iso(2) }], now: 2 }).stage).toBe("due");
    expect(plan({ touches: [first], now: 2, snoozedUntil: iso(5) })).toMatchObject({ stage: "upcoming", nextAt: iso(5), snoozed: true });
    expect(plan({ touches: [first], now: 6, snoozedUntil: iso(5) }).stage).toBe("due");
  });

  it("starts from the status change when no touch was logged, and ignores closed candidates", () => {
    expect(plan({ touches: [], now: 1 })).toMatchObject({ stage: "due", firstContactAt: iso(0) });
    expect(followUpPlan({ status: "won", matchKind: "x", statusChangedAt: iso(0), touches: [], snoozedUntil: null, now: at(1) })).toBeNull();
  });

  it("orders due before stalled, cold and upcoming", () => {
    const due = plan({ touches: [first], now: 2 });
    const upcoming = plan({ touches: [first], now: 0 });
    expect([upcoming, due].sort(compareFollowUps)[0]).toBe(due);
  });
});
