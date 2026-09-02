import { describe, it, expect } from "vitest";
import { embedTexts, cosineSimilarity } from "./embed";

describe("embeddings (gateway echo default)", () => {
  it("is deterministic; identical text -> cosine 1; configured dim", async () => {
    const [a, b] = await embedTexts(["sony wireless headphones", "sony wireless headphones"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(512);
    expect(cosineSimilarity(a!, b!)).toBeCloseTo(1, 6);
  });

  it("ranks similar items above dissimilar", async () => {
    const [base, similar, different] = await embedTexts([
      "sony wireless noise cancelling headphones",
      "sony wireless headphones over ear",
      "stackable oak dining chairs",
    ]);
    expect(cosineSimilarity(base!, similar!)).toBeGreaterThan(cosineSimilarity(base!, different!));
  });

  it("empty text -> zero vector", async () => {
    const [v] = await embedTexts([""]);
    expect(cosineSimilarity(v!, v!)).toBe(0);
  });
});
