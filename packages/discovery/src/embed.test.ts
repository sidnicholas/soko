import { describe, it, expect } from "vitest";
import { defaultEmbedding, cosineSimilarity } from "./embed";

describe("embeddings", () => {
  it("is deterministic; identical text -> cosine 1; fixed dim", () => {
    const a = defaultEmbedding.embed("sony wireless headphones");
    const b = defaultEmbedding.embed("sony wireless headphones");
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("ranks similar items above dissimilar", () => {
    const base = defaultEmbedding.embed("sony wireless noise cancelling headphones");
    const similar = defaultEmbedding.embed("sony wireless headphones over ear");
    const different = defaultEmbedding.embed("stackable oak dining chairs");
    expect(cosineSimilarity(base, similar)).toBeGreaterThan(cosineSimilarity(base, different));
  });

  it("empty text -> zero vector", () => {
    const v = defaultEmbedding.embed("");
    expect(cosineSimilarity(v, v)).toBe(0);
  });
});
