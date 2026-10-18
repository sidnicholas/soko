/**
 * Follow-up cadence for candidates being worked (ADR-047). Pure: the same
 * touches and clock give the same plan.
 *
 * Contacted, no answer yet: follow up on a fixed schedule counted from the
 * first contact, at least a day after the last touch, then let it go cold.
 * Common practice in outreach is several touches spread over a few weeks
 * with growing gaps, each adding something new, ending with a polite last
 * note; most replies come after the first message. Marketplace listings
 * (people buying or selling an item) move in days, so their schedule is
 * tighter than business offers.
 *
 * Responded: keep momentum by proposing the next concrete step within two
 * days of the last exchange; after two weeks without one it has stalled.
 */

export type TouchKind = "contacted" | "follow_up" | "responded" | "note";
export type FollowUpStage = "due" | "upcoming" | "cold" | "stalled";

export interface Touch {
  kind: TouchKind;
  at: string;
}

export interface Cadence {
  /** Days after the first contact when follow-up 1, 2, 3... is due. */
  offsetsDays: number[];
  /** Days after the last follow-up with no answer before it is cold. */
  coldAfterDays: number;
}

export const CADENCES: Record<"listing" | "business", Cadence> = {
  listing: { offsetsDays: [1, 3, 6], coldAfterDays: 4 },
  business: { offsetsDays: [3, 7, 14], coldAfterDays: 7 },
};
export const RESPONDED_NEXT_STEP_DAYS = 2;
export const RESPONDED_STALLED_DAYS = 14;
const MIN_GAP_DAYS = 1;
const DAY = 86_400_000;

/** Marketplace-style candidates (an item bought or sold) follow the tighter schedule. */
export const cadenceFor = (matchKind: string): Cadence => (matchKind === "problem_to_service" ? CADENCES.business : CADENCES.listing);

/** What to say on each follow-up, by its position (1 = the first follow-up). */
const GUIDANCE: string[] = [
  "Short bump in the same thread: restate in one line why you wrote and ask a yes-or-no question.",
  "Add something new: a comparable price, a photo, a pickup date or a firm offer. Try a second channel if you have one.",
  "Last note: say you will stop following up and leave the door open.",
];

export interface FollowUpPlan {
  stage: FollowUpStage;
  /** When the next touch is due (or when it goes cold); null once cold or stalled. */
  nextAt: string | null;
  /** The next touch's number counting the first contact (2 = first follow-up), or null. */
  step: number | null;
  /** Total touches in the schedule (first contact plus follow-ups), or null when responded. */
  of: number | null;
  action: string;
  guidance: string;
  firstContactAt: string;
  lastTouchAt: string;
  outboundTouches: number;
  snoozed: boolean;
}

export function followUpPlan(input: { status: string; matchKind: string; statusChangedAt: string | null; touches: Touch[]; snoozedUntil: string | null; now: Date }): FollowUpPlan | null {
  if (input.status !== "contacted" && input.status !== "responded") return null;
  const now = input.now.getTime();
  const since = input.statusChangedAt ? Date.parse(input.statusChangedAt) : 0;
  const touches = input.touches.filter((t) => t.kind !== "note").map((t) => ({ kind: t.kind, at: Date.parse(t.at) })).sort((a, b) => a.at - b.at);
  const outbound = touches.filter((t) => t.kind === "contacted" || t.kind === "follow_up");
  const fallback = since || now;
  const first = outbound[0]?.at ?? fallback;
  const iso = (ms: number) => new Date(ms).toISOString();

  let plan: FollowUpPlan;
  if (input.status === "contacted") {
    const current = outbound.filter((t) => t.at >= since - 60_000);
    const sent = Math.max(1, current.length);
    const last = Math.max(current.at(-1)?.at ?? fallback, first);
    const cadence = cadenceFor(input.matchKind);
    const of = cadence.offsetsDays.length + 1;
    if (sent < of) {
      const nextAt = Math.max(first + cadence.offsetsDays[sent - 1]! * DAY, last + MIN_GAP_DAYS * DAY);
      plan = {
        stage: now >= nextAt ? "due" : "upcoming",
        nextAt: iso(nextAt),
        step: sent + 1,
        of,
        action: `Follow-up ${sent} of ${of - 1}`,
        guidance: GUIDANCE[Math.min(sent - 1, GUIDANCE.length - 1)]!,
        firstContactAt: iso(first),
        lastTouchAt: iso(last),
        outboundTouches: sent,
        snoozed: false,
      };
    } else {
      const coldAt = last + cadence.coldAfterDays * DAY;
      const cold = now >= coldAt;
      plan = {
        stage: cold ? "cold" : "upcoming",
        nextAt: cold ? null : iso(coldAt),
        step: null,
        of,
        action: cold ? "Gone cold" : "Waiting for a reply to the last note",
        guidance: cold ? `No reply after ${sent} touches. Mark it lost (no response), or snooze it if timing is the issue.` : "Nothing more to send; it goes cold if there is no answer.",
        firstContactAt: iso(first),
        lastTouchAt: iso(last),
        outboundTouches: sent,
        snoozed: false,
      };
    }
  } else {
    const last = Math.max(touches.filter((t) => t.at >= since - 60_000).at(-1)?.at ?? fallback, since);
    const stalled = now >= last + RESPONDED_STALLED_DAYS * DAY;
    const nextAt = last + RESPONDED_NEXT_STEP_DAYS * DAY;
    plan = {
      stage: stalled ? "stalled" : now >= nextAt ? "due" : "upcoming",
      nextAt: stalled ? null : iso(nextAt),
      step: null,
      of: null,
      action: stalled ? "Stalled" : "Next step",
      guidance: stalled
        ? `No movement in ${RESPONDED_STALLED_DAYS} days. Ask directly whether it is still on, or close it.`
        : "Keep momentum: confirm the next concrete step (price, pickup time, a call).",
      firstContactAt: iso(first),
      lastTouchAt: iso(last),
      outboundTouches: outbound.length,
      snoozed: false,
    };
  }

  // A snooze hides it until the chosen time, whatever the stage.
  if (input.snoozedUntil && Date.parse(input.snoozedUntil) > now) {
    return { ...plan, stage: "upcoming", nextAt: input.snoozedUntil, snoozed: true };
  }
  return plan;
}

const STAGE_ORDER: Record<FollowUpStage, number> = { due: 0, stalled: 1, cold: 2, upcoming: 3 };

/** Due first (oldest due first), then stalled, cold, and upcoming by date. */
export function compareFollowUps(a: FollowUpPlan, b: FollowUpPlan): number {
  return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.nextAt ?? a.lastTouchAt).localeCompare(b.nextAt ?? b.lastTouchAt);
}
