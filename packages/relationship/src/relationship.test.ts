import { describe, it, expect } from "vitest";
import { checkFreshness, consentInForce, isArchiveDue, mayContact, normalizeChannel, suppressionHash } from "./index";

describe("normalizeChannel", () => {
  it("normalizes each kind and rejects what is not one", () => {
    expect(normalizeChannel("email", " Mailto:Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeChannel("email", "not-an-email")).toBeNull();
    expect(normalizeChannel("phone", "+1 (555) 010-2030")).toBe("+15550102030");
    expect(normalizeChannel("phone", "12")).toBeNull();
    expect(normalizeChannel("website", "https://www.Acme.com/Contact/")).toBe("acme.com/contact");
    expect(normalizeChannel("website", "acme.com")).toBe("acme.com");
    expect(normalizeChannel("website", "javascript:alert(1)")).toBeNull();
  });
  it("hashes a suppression by kind and value", () => {
    expect(suppressionHash("email", "a@b.co")).toMatch(/^[0-9a-f]{64}$/);
    expect(suppressionHash("email", "a@b.co")).not.toBe(suppressionHash("phone", "a@b.co"));
  });
});

describe("retention", () => {
  const now = new Date("2026-10-17T00:00:00Z");
  it("archives after 90 days without activity", () => {
    expect(isArchiveDue("2026-07-19T00:00:00Z", now)).toBe(true);
    expect(isArchiveDue("2026-07-20T00:00:01Z", now)).toBe(false);
  });
  it("purges only when every checkable channel fails; nothing checkable is kept", async () => {
    const probes = (site: boolean, mx: boolean) => ({ websiteReachable: async () => site, emailDomainAcceptsMail: async () => mx });
    const channels = [{ kind: "website", normalized_value: "acme.com" }, { kind: "email", normalized_value: "jo@acme.com" }, { kind: "phone", normalized_value: "+15550102030" }];
    expect((await checkFreshness(channels, probes(false, false))).verdict).toBe("stale");
    expect((await checkFreshness(channels, probes(false, true))).verdict).toBe("fresh");
    expect((await checkFreshness([{ kind: "phone", normalized_value: "+15550102030" }], probes(false, false))).verdict).toBe("unverifiable");
    // A probe that throws or cannot tell is not evidence: that channel is left unchecked.
    expect((await checkFreshness(channels, { websiteReachable: async () => { throw new Error("dns"); }, emailDomainAcceptsMail: async () => true })).verdict).toBe("fresh");
    expect((await checkFreshness(channels, { websiteReachable: async () => null, emailDomainAcceptsMail: async () => false })).verdict).toBe("stale");
    expect((await checkFreshness(channels, { websiteReachable: async () => null, emailDomainAcceptsMail: async () => { throw new Error("SERVFAIL"); } })).verdict).toBe("unverifiable");
  });
});

describe("consent", () => {
  const r = (over: Partial<{ channel_kind: string; purpose: string; status: string; basis: string; recorded_at: string; expires_at: string | null }>) => ({ channel_kind: "email", purpose: "outreach", status: "granted", basis: "public_business_contact", recorded_at: "2026-10-01T00:00:00Z", expires_at: null, ...over });
  it("assumes nothing: no record means no contact", () => {
    expect(mayContact([], "email", "outreach")).toEqual({ allowed: false, reason: "no_consent_recorded" });
  });
  it("uses the latest record, and an opt-out always wins", () => {
    expect(mayContact([r({}), r({ status: "denied", recorded_at: "2026-10-05T00:00:00Z" })], "email", "outreach").allowed).toBe(false);
    expect(mayContact([r({ status: "denied" }), r({ recorded_at: "2026-10-05T00:00:00Z" })], "email", "outreach").allowed).toBe(true);
    expect(mayContact([r({ status: "opted_out", channel_kind: "any" }), r({ recorded_at: "2026-10-09T00:00:00Z" })], "email", "outreach")).toEqual({ allowed: false, reason: "consent_opted_out" });
  });
  it("ignores expired records and other purposes", () => {
    expect(consentInForce([r({ expires_at: "2026-10-02T00:00:00Z" })], "email", "outreach", new Date("2026-10-10T00:00:00Z"))).toBeNull();
    expect(mayContact([r({ purpose: "marketing" })], "email", "outreach").allowed).toBe(false);
  });
});
