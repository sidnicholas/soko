import { describe, it, expect } from "vitest";
import { apifyClient, canonicalListingKey, mapApifyItem, mappedRoots, parseFieldMap, type ApifyFieldMap } from "./apify";

const MAP: ApifyFieldMap = { kind: "supply", externalId: "id", title: "name", description: "desc", url: "link", price: "offer.price", currency: "const:usd", category: "const:electronics", sellerName: "seller.name", location: "where" };
const ITEM = { id: 42, name: "  Dell <b>monitor</b> lot ", desc: "<p>20 units</p>", link: "https://www.example.com/lot/42/", offer: { price: "1,250.50" }, seller: { name: "Acme" }, where: "Austin, TX" };

describe("mapApifyItem", () => {
  it("maps paths and constants, strips markup, stores price in minor units", () => {
    const m = mapApifyItem("apify:s1", ITEM, MAP, null, { now: new Date("2026-10-17T00:00:00Z") });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.observation.ref).toEqual({ source_id: "apify:s1", external_id: "42", uri: "https://www.example.com/lot/42/" });
    expect(m.observation.content).toEqual({
      title: "Dell monitor lot", description: "20 units", category: "electronics", price: 125050, currency: "USD", quantity: null, condition: null,
      seller: { name: "Acme" }, location: { label: "Austin, TX" },
    });
    expect(m.canonicalKey).toBe("example.com/lot/42");
    expect(m.observation.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads minor-unit prices as they are", () => {
    const m = mapApifyItem("s", { ...ITEM, offer: { price: 999 } }, { ...MAP, priceUnit: "minor" }, null);
    expect(m.ok && m.observation.content["price"]).toBe(999);
  });

  it("quarantines items with fields the source is not expected to return", () => {
    const expected = Object.keys(ITEM);
    expect(mapApifyItem("s", ITEM, MAP, expected).ok).toBe(true);
    expect(mapApifyItem("s", { ...ITEM, sellerEmail: "x@y.com", tracking: 1 }, MAP, expected)).toEqual({ ok: false, reason: "unexpected_fields", fields: ["sellerEmail", "tracking"], externalId: "42" });
    // A person released it: read as it is.
    expect(mapApifyItem("s", { ...ITEM, tracking: 1 }, MAP, expected, { acceptUnexpected: true }).ok).toBe(true);
  });

  it("quarantines missing required fields and unreadable prices", () => {
    expect(mapApifyItem("s", { ...ITEM, name: "  " }, MAP, null)).toMatchObject({ ok: false, reason: "missing_required", fields: ["name"] });
    expect(mapApifyItem("s", { ...ITEM, id: undefined }, MAP, null)).toMatchObject({ ok: false, reason: "missing_required", fields: ["id"], externalId: null });
    expect(mapApifyItem("s", { ...ITEM, offer: { price: "call us" } }, MAP, null)).toMatchObject({ ok: false, reason: "invalid_value", fields: ["offer.price"] });
    expect(mapApifyItem("s", "not an object", MAP, null)).toMatchObject({ ok: false, reason: "invalid_value" });
  });

  it("never keeps a non-http link", () => {
    const m = mapApifyItem("s", { ...ITEM, link: "javascript:alert(1)" }, MAP, null);
    expect(m.ok && m.observation.ref.uri).toBeUndefined();
    expect(m.ok && m.canonicalKey).toBeNull();
  });
});

describe("dropFields", () => {
  it("removes the fields before the expected-field check and before anything is stored", () => {
    const map = { ...MAP, dropFields: ["seller"] };
    const m = mapApifyItem("s", { ...ITEM, seller: { name: "Private Person" } }, map, Object.keys(ITEM).filter((k) => k !== "seller"));
    expect(m.ok).toBe(true);
    expect(JSON.stringify(m)).not.toContain("Private Person");
    expect(parseFieldMap({ kind: "supply", externalId: "id", title: "t", dropFields: "seller" })).toEqual({ errors: ["dropFields must be a list of field names"] });
  });
});

describe("canonicalListingKey", () => {
  it("gives an eBay item one key however its URL is written", () => {
    expect(canonicalListingKey("https://www.ebay.com/itm/123456789012?hash=x")).toBe("ebay/itm/123456789012");
    expect(canonicalListingKey("https://m.ebay.com/itm/dell-monitor-lot/123456789012")).toBe("ebay/itm/123456789012");
    expect(canonicalListingKey("https://www.ebay.co.uk/itm/123456789012")).toBe("ebay/itm/123456789012");
  });
  it("normalizes other URLs and rejects non-http ones", () => {
    expect(canonicalListingKey("https://WWW.Example.com/Lot/7/?ref=a")).toBe("example.com/lot/7");
    expect(canonicalListingKey("ftp://example.com/x")).toBeNull();
    expect(canonicalListingKey("nope")).toBeNull();
  });
});

describe("parseFieldMap", () => {
  it("requires kind, externalId and title and rejects other shapes", () => {
    expect(parseFieldMap({ kind: "supply", externalId: "id", title: "t", extra: "ignored" })).toEqual({ map: { kind: "supply", externalId: "id", title: "t" } });
    expect(parseFieldMap({ kind: "sale", title: 3 })).toEqual({ errors: ["kind must be supply or demand", "externalId is required", "title must be a field path or const:value"] });
    expect(parseFieldMap([])).toEqual({ errors: ["field map must be an object"] });
  });
  it("lists the top-level fields a map reads", () => {
    expect(mappedRoots(MAP).sort()).toEqual(["desc", "id", "link", "name", "offer", "seller", "where"]);
  });
});

describe("apifyClient", () => {
  it("starts a pinned build with caps and a secret-carrying webhook, and reads runs and datasets", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      const body = path.includes("/datasets/") ? [{ id: 1 }] : { data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } };
      return { ok: true, status: 201, json: async () => body, text: async () => "" } as Response;
    }) as unknown as typeof fetch;
    const c = apifyClient({ token: "tok", fetchImpl });
    const run = await c.startRun({ actorId: "acme/lots", build: "0.1.7", input: { q: "monitors" }, maxItems: 200, maxTotalChargeUsd: 0.5, timeoutSecs: 600, webhook: { url: "https://api.example.com/v1/webhooks/apify", secret: "s3" } });
    expect(run).toMatchObject({ id: "run1", defaultDatasetId: "ds1" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v2/acts/acme~lots/runs");
    expect(Object.fromEntries([...u.searchParams].filter(([k]) => k !== "webhooks"))).toEqual({ build: "0.1.7", maxItems: "200", maxTotalChargeUsd: "0.5000", timeout: "600" });
    const hooks = JSON.parse(Buffer.from(u.searchParams.get("webhooks")!, "base64").toString("utf8"));
    expect(hooks[0]).toMatchObject({ requestUrl: "https://api.example.com/v1/webhooks/apify", eventTypes: expect.arrayContaining(["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED"]) });
    expect(JSON.parse(hooks[0].headersTemplate)).toEqual({ "x-apify-webhook-secret": "s3" });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ q: "monitors" });

    await c.getRun("run1");
    expect(new URL(calls[1]!.url).pathname).toBe("/v2/actor-runs/run1");
    expect(await c.datasetItems("ds1", 250, 250)).toEqual([{ id: 1 }]);
    expect(new URL(calls[2]!.url).search).toBe("?format=json&clean=true&offset=250&limit=250");
  });

  it("throws with the status on a failed call", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "actor not found" }) as Response) as unknown as typeof fetch;
    await expect(apifyClient({ token: "t", fetchImpl }).getRun("x")).rejects.toThrow("404");
  });
});
