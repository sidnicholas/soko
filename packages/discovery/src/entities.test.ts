import { describe, it, expect } from "vitest";
import { canonicalEntityKey } from "./entities";

describe("canonicalEntityKey", () => {
  it("groups the same item regardless of word order", () => {
    const a = canonicalEntityKey("electronics", "27 inch 4k monitor");
    const b = canonicalEntityKey("electronics", "monitor 4k inch 27");
    expect(a).toBe(b);
    expect(a.startsWith("electronics::")).toBe(true);
  });

  it("separates items by category", () => {
    expect(canonicalEntityKey("electronics", "alpha beta")).not.toBe(canonicalEntityKey("furniture", "alpha beta"));
  });

  it("falls back to uncategorized and drops noise words", () => {
    const key = canonicalEntityKey(null, "the new widget for sale");
    expect(key.startsWith("uncategorized::")).toBe(true);
    expect(key).not.toContain("the");
    expect(key).toContain("widget");
  });
});
