import { describe, it, expect } from "vitest";
import type { RawObservation } from "@opportunity-os/contracts";
import { normalizeObservation, safeHttpUrl } from "./normalize";

function supplyObs(content: Record<string, unknown>, uri?: string): RawObservation {
  return {
    ref: { source_id: "test", external_id: "x1", uri },
    kind: "supply",
    captured_at: new Date().toISOString(),
    content: { title: "Thing", ...content },
    content_hash: "a".repeat(64),
    source_reliability: 0.5,
    automation: "official_api",
  };
}

describe("safeHttpUrl", () => {
  it("keeps http(s) links and drops anything else", () => {
    expect(safeHttpUrl("https://example.com/item/1")).toBe("https://example.com/item/1");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe("normalizeObservation listing details", () => {
  it("never carries an unsafe link from a listing or its seller", () => {
    const n = normalizeObservation(supplyObs({ seller: { name: "Shop", url: "javascript:alert(1)" } }, "javascript:alert(1)"));
    expect(n).toMatchObject({ uri: null, seller: { name: "Shop" } });
    expect(n.kind === "supply" && n.seller?.url).toBeFalsy();
  });

  it("builds a location label from its parts and drops an empty one", () => {
    const withCity = normalizeObservation(supplyObs({ location: { city: "Austin", region: "TX", country: "US" } }));
    expect(withCity).toMatchObject({ location: { label: "Austin, TX, US", city: "Austin", region: "TX", country: "US" } });
    const postalOnly = normalizeObservation(supplyObs({ location: { postalCode: "787**", country: "US" } }));
    expect(postalOnly).toMatchObject({ location: { label: "787**, US" } });
    expect(normalizeObservation(supplyObs({ location: {} }))).toMatchObject({ location: null });
  });

  it("ignores a seller without a name", () => {
    expect(normalizeObservation(supplyObs({ seller: { url: "https://example.com/u/1" } }))).toMatchObject({ seller: null });
  });
});
