import { describe, it, expect } from "vitest";
import { classifyInbound, newMessageId, outreachContentHash, referencedIds, renderOutreachText, replyText, signUnsubscribe, verifyUnsubscribe, withinSendWindow } from "./index";

describe("outreach content", () => {
  it("binds the approval to recipient, subject and body", () => {
    const base = { to: "Jo@Acme.com", subject: "Your pallets", body: "Hi Jo" };
    expect(outreachContentHash(base)).toBe(outreachContentHash({ ...base, to: "jo@acme.com" }));
    expect(outreachContentHash(base)).not.toBe(outreachContentHash({ ...base, body: "Hi Jo!" }));
    expect(outreachContentHash(base)).not.toBe(outreachContentHash({ ...base, to: "al@acme.com" }));
  });
  it("adds identity, postal address and opt-out to every message", () => {
    const text = renderOutreachText({ body: "Hi Jo\n\n", fromName: "Sam Lee", postalAddress: "1 Main St, Detroit, MI 48201", unsubscribeUrl: "https://api.example.com/v1/outreach/unsubscribe?t=x" });
    expect(text).toContain("Hi Jo\n\n--\nSam Lee\n1 Main St, Detroit, MI 48201\n");
    expect(text).toContain('Reply "unsubscribe" or open https://api.example.com/v1/outreach/unsubscribe?t=x');
  });
  it("makes Message-IDs on the sending domain", () => {
    expect(newMessageId("sam@getacme.com")).toMatch(/^<[a-z0-9]+\.[0-9a-f]{18}@getacme\.com>$/);
  });
});

describe("unsubscribe token", () => {
  it("round-trips and rejects tampering or another secret", () => {
    const t = signUnsubscribe("s3cret", "<abc@getacme.com>");
    expect(verifyUnsubscribe("s3cret", t)).toBe("<abc@getacme.com>");
    expect(verifyUnsubscribe("other", t)).toBeNull();
    const [id, mac] = t.split(".");
    expect(verifyUnsubscribe("s3cret", `${Buffer.from("<def@getacme.com>").toString("base64url")}.${mac}`)).toBeNull();
    expect(verifyUnsubscribe("s3cret", `${id}`)).toBeNull();
    expect(verifyUnsubscribe("s3cret", "garbage")).toBeNull();
  });
});

describe("send window", () => {
  const w = { start: 8, end: 18, timezone: "America/Detroit", weekends: false };
  it("sends on weekdays inside local hours only", () => {
    // Friday 2026-10-16 14:00 UTC = 10:00 in Detroit (EDT).
    expect(withinSendWindow(new Date("2026-10-16T14:00:00Z"), w)).toBe(true);
    // 23:00 UTC = 19:00 local.
    expect(withinSendWindow(new Date("2026-10-16T23:00:00Z"), w)).toBe(false);
    // Saturday.
    expect(withinSendWindow(new Date("2026-10-17T14:00:00Z"), w)).toBe(false);
    expect(withinSendWindow(new Date("2026-10-17T14:00:00Z"), { ...w, weekends: true })).toBe(true);
  });
});

describe("inbound classification", () => {
  const m = (over: Partial<{ from: string; subject: string; text: string; headers: Record<string, string> }>) => ({ from: "jo@acme.com", subject: "Re: Your pallets", text: "Sure, call me Tuesday.", headers: {}, ...over });
  it("tells bounces, auto-replies, opt-outs and replies apart", () => {
    expect(classifyInbound(m({ from: "MAILER-DAEMON@mx.hostinger.com", subject: "Undelivered Mail Returned to Sender" }))).toBe("bounce");
    expect(classifyInbound(m({ headers: { "content-type": "multipart/report; report-type=delivery-status" } }))).toBe("bounce");
    expect(classifyInbound(m({ headers: { "auto-submitted": "auto-replied" } }))).toBe("auto_reply");
    expect(classifyInbound(m({ subject: "Out of Office: back Monday" }))).toBe("auto_reply");
    expect(classifyInbound(m({ text: "Please remove me from your list." }))).toBe("opt_out");
    expect(classifyInbound(m({ text: "STOP" }))).toBe("opt_out");
    expect(classifyInbound(m({ subject: "unsubscribe", text: "" }))).toBe("opt_out");
    expect(classifyInbound(m({}))).toBe("reply");
  });
  it("ignores our own footer quoted under a reply", () => {
    const text = 'Yes, still available.\n\nOn Fri, Oct 16, 2026 at 10:00 AM Sam <sam@getacme.com> wrote:\n> Hi\n> Not interested? Reply "unsubscribe"';
    expect(replyText(text)).toBe("Yes, still available.");
    expect(classifyInbound(m({ text }))).toBe("reply");
    expect(classifyInbound(m({ text: "Yes\n> Reply unsubscribe to stop" }))).toBe("reply");
  });
  it("reads the thread references, In-Reply-To first", () => {
    expect(referencedIds("<b@x>", "<a@x> <b@x>")).toEqual(["<b@x>", "<a@x>"]);
    expect(referencedIds(null, ["<a@x>", "<c@x>"])).toEqual(["<c@x>", "<a@x>"]);
    expect(referencedIds(undefined, undefined)).toEqual([]);
  });
});
