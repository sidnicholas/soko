import { describe, it, expect } from "vitest";
import { canonicalCategory } from "./category";

describe("canonicalCategory", () => {
  it("maps marketplace labels onto canonical V1 categories", () => {
    expect(canonicalCategory("Monitors")).toBe("electronics");
    expect(canonicalCategory("Cell Phones & Accessories")).toBe("electronics");
    expect(canonicalCategory("Electric Guitars / Solid Body")).toBe("musical_instruments");
    expect(canonicalCategory("Amps / Guitar Combos")).toBe("musical_instruments");
    expect(canonicalCategory("Office Chairs")).toBe("furniture");
    expect(canonicalCategory("Men's Shoes")).toBe("apparel");
    expect(canonicalCategory("Power Tools")).toBe("tools");
  });

  it("leaves unknown labels unchanged so the gate still fails closed", () => {
    expect(canonicalCategory("Rare Coins")).toBe("Rare Coins");
    expect(canonicalCategory(null)).toBeNull();
  });
});
