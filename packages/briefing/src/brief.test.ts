import { describe, it, expect } from "vitest";
import type { BriefData } from "@opportunity-os/db";
import { absolute, buildBrief, localDateHour, renderBriefText } from "./brief";

const data = (over: Partial<BriefData> = {}): BriefData => ({
  periodStart: "2026-10-16T11:00:00.000Z",
  periodEnd: "2026-10-17T11:00:00.000Z",
  candidates: [{ id: "c1", title: "Broker 40 pallets", bucket: "act_now", score: 81.4, ev_low_usd: 300, ev_high_usd: 900, confidence: "high", lead_kind: "supply", lead_url: "https://fb.example/item/1", counter_url: "https://buyer.example/wanted" }],
  actionableCount: 3,
  outreach: { needsReview: [{ conversation_id: "v1", party_name: "Jo", subject: "Re: pallets", classification: "reply" }], drafts: 2, queued: 1, exceptions: 0, sent: 4, replies: 1, optOuts: 0, bounces: 1 },
  deals: { checked: 50, goodDeals: 2, leadsRaised: 2, top: [{ lead_id: "l1", title: "Dyson V11", url: "https://fb.example/item/2", discount: 0.42, price_minor: 12000, comp_median_minor: 20700, currency: "USD", demand_term: null }] },
  sources: { active: 9, pausedInPeriod: [{ id: "s1", name: "Craigslist", reason: "3 failures" }], failing: [], apifyRuns: 6, apifyFailed: 1, apifyItemsNew: 140, quarantinePending: 3 },
  spend: { intelUsd: 0.8, apifyUsd: 2.4 },
  followUps: { due: 2, cold: 1, stalled: 0, upcoming: 4, top: [{ id: "c9", title: "Sell the drill set", stage: "due", action: "Follow-up 1 of 3", next_at: "2026-10-17T10:00:00.000Z", last_touch_at: "2026-10-16T09:00:00.000Z", lead_url: "https://fb.example/item/9" }] },
  ...over,
});

describe("daily brief", () => {
  const opts = { date: "2026-10-17", timezone: "America/Detroit", intelBudgetUsd: 1, apifyBudgetUsd: 5 };

  it("summarizes each section, and every item cites a source", () => {
    const b = buildBrief(data(), opts);
    expect(b.headline).toBe("2 follow-ups due · 3 new actionable candidates · 1 reply to review · 2 good deals · $3.20 spent");
    expect(b.sections.map((s) => s.key)).toEqual(["follow_ups", "candidates", "outreach", "deals", "sources", "spend"]);
    for (const s of b.sections) for (const i of s.items) expect(i.citations.length).toBeGreaterThan(0);
    const f = b.sections.shift()!;
    expect(f.summary).toBe("2 follow-ups due, 1 gone cold, 4 waiting.");
    expect(f.items[0]!).toMatchObject({ text: "Sell the drill set", detail: "due · Follow-up 1 of 3 · last touch 2026-10-16" });
    expect(f.items[0]!.citations.map((x) => x.href)).toEqual(["/follow-ups#c9", "https://fb.example/item/9"]);
    const c = b.sections[0]!;
    expect(c.summary).toBe("3 candidates reached act now or verify next; top 1 below.");
    expect(c.items[0]!.detail).toBe("act now · score 81 · expected $300–$900 · high confidence");
    expect(c.items[0]!.citations.map((x) => x.href)).toEqual(["/queue", "https://fb.example/item/1", "https://buyer.example/wanted"]);
    expect(b.sections[1]!.items[0]!.citations[0]!.href).toBe("/outreach/v1");
    expect(b.sections[2]!.items[0]!.detail).toBe("$120, 42% under the comparables' median of $207");
    expect(b.sections[4]!.items.map((i) => i.text)).toContain("$1.07 per actionable candidate");
  });

  it("says plainly when nothing happened", () => {
    const b = buildBrief(
      data({
        candidates: [],
        actionableCount: 0,
        outreach: { needsReview: [], drafts: 0, queued: 0, exceptions: 0, sent: 0, replies: 0, optOuts: 0, bounces: 0 },
        deals: { checked: 0, goodDeals: 0, leadsRaised: 0, top: [] },
        spend: { intelUsd: 0, apifyUsd: 0 },
        followUps: { due: 0, cold: 0, stalled: 0, upcoming: 0, top: [] },
      }),
      opts,
    );
    expect(b.headline).toBe("0 new actionable candidates · $0 spent");
    expect(b.sections[0]!.summary).toBe("Nothing being worked.");
    expect(b.sections[1]!.summary).toBe("No new actionable candidates.");
    expect(b.sections[3]!.summary).toBe("No listings were priced.");
  });

  it("renders the email with absolute links", () => {
    const text = renderBriefText(buildBrief(data(), opts), "https://app.example.com/");
    expect(text).toContain("Conversation: https://app.example.com/outreach/v1");
    expect(text).toContain("Supply source: https://fb.example/item/1");
    expect(text).toContain("Open in Opportunity OS: https://app.example.com/brief?date=2026-10-17");
    expect(absolute("/queue", null)).toBeNull();
    expect(renderBriefText(buildBrief(data(), opts), null)).not.toContain("Action Queue:");
  });

  it("reads the local date and hour", () => {
    expect(localDateHour(new Date("2026-10-17T03:30:00Z"), "America/Detroit")).toEqual({ date: "2026-10-16", hour: 23 });
    expect(localDateHour(new Date("2026-10-17T11:00:00Z"), "America/Detroit")).toEqual({ date: "2026-10-17", hour: 7 });
  });
});
