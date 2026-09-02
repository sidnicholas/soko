/**
 * Text embeddings for entity similarity (§ market graph). V1 uses a
 * deterministic, offline hashed bag-of-words vector so substitutes/comparables
 * work with no external model and no pgvector. The interface is the seam: swap
 * in a real provider (OpenAI/Voyage via the LLM gateway) and pgvector at scale
 * (ADR-024) without touching callers.
 */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(text: string): number[];
}

const STOP: Record<string, true> = { the: true, and: true, for: true, with: true, new: true, used: true };

export class LocalHashEmbedding implements EmbeddingProvider {
  constructor(readonly dim = 64) {}

  embed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 2 || STOP[raw]) continue;
      let h = 2166136261;
      for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    return v.map((x) => x / norm);
  }
}

export const defaultEmbedding: EmbeddingProvider = new LocalHashEmbedding();

/** Cosine similarity. Inputs are L2-normalized, so this is just the dot product. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
