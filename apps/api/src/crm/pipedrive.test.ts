import { describe, it, expect } from "vitest";
import { dealNoteHtml, parsePipedriveDealEvent, pipedriveClient } from "./pipedrive";

describe("parsePipedriveDealEvent (webhook v2)", () => {
  const meta = { action: "change", entity: "deal", entity_id: 42, id: "evt-1", timestamp: "2026-10-16T12:00:00.000Z" };

  it("reads a deal change: status, stage, value, currency, lost reason", () => {
    expect(parsePipedriveDealEvent({ meta, data: { status: "lost", stage_id: 3, value: 900, currency: "USD", lost_reason: " Price too high " }, previous: { status: "open" } })).toEqual({
      provider: "pipedrive", eventId: "evt-1", action: "change", entityId: "42", at: "2026-10-16T12:00:00.000Z",
      status: "lost", stageId: 3, value: 900, currency: "USD", lostReason: "Price too high",
    });
  });

  it("takes a deleted deal's last state from previous", () => {
    expect(parsePipedriveDealEvent({ meta: { ...meta, action: "delete" }, data: null, previous: { status: "open", value: 10 } })).toMatchObject({ action: "delete", status: "open", value: 10 });
  });

  it("ignores other entities and malformed bodies", () => {
    expect(parsePipedriveDealEvent({ meta: { ...meta, entity: "person" }, data: {} })).toBeNull();
    expect(parsePipedriveDealEvent({ meta: { ...meta, action: "merge" }, data: {} })).toBeNull();
    expect(parsePipedriveDealEvent({ meta: { entity: "deal", action: "change" }, data: {} })).toBeNull();
    expect(parsePipedriveDealEvent("nope")).toBeNull();
  });
});

describe("dealNoteHtml", () => {
  it("escapes third-party text and links only http(s) URLs", () => {
    const html = dealNoteHtml(
      { title: "t", lead_title: "<script>x</script>", lead_url: "javascript:alert(1)", lead_summary: "a & b", counter_url: "https://buyer.example.com", counter_summary: "Buyer", economics: { deal: { mode: "brokerage", netProfitUsd: [100, 300], probability: [0.2, 0.4], daysToCash: [7, 21], capitalRequiredUsd: 0, costs: [{ kind: "payment_fees", usd: [2, 10], label: "default_assumption" }] } } },
      [{ kind: "source_page", url: "https://src.example.com", title: "Source" }],
      "https://app.example.com/queue",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="https://buyer.example.com">Buyer</a>');
    expect(html).toContain("net $100–$300");
    expect(html).toContain('<a href="https://app.example.com/queue">');
  });
});

describe("pipedriveClient", () => {
  it("creates a deal on API v2 with the token header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 77, status: "open", stage_id: 1, value: 250, currency: "USD" } }) } as Response;
    }) as unknown as typeof fetch;
    const pd = pipedriveClient({ companyDomain: "acme", apiToken: "tok", fetchImpl });
    const deal = await pd.createDeal({ title: "Broker chairs", value: 250, currency: "USD", stageId: 1, expectedCloseDate: "2026-11-01" });
    expect(deal.id).toBe(77);
    expect(calls[0]!.url).toBe("https://acme.pipedrive.com/api/v2/deals");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-api-token"]).toBe("tok");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ title: "Broker chairs", value: 250, currency: "USD", stage_id: 1, expected_close_date: "2026-11-01" });
    expect(pd.dealUrl(77)).toBe("https://acme.pipedrive.com/deal/77");
  });

  it("throws on a failed call", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({ success: false, error: "unauthorized" }) }) as Response) as unknown as typeof fetch;
    await expect(pipedriveClient({ companyDomain: "acme", apiToken: "bad", fetchImpl }).createDeal({ title: "x", value: null, currency: "USD" })).rejects.toThrow("401");
  });
});
