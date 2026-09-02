import { EmbeddingGateway } from "@opportunity-os/llm-gateway";

/**
 * Entity embeddings come from the LLM gateway's embedding provider (OpenAI
 * text-embedding-3-small @ 512 by default, Voyage alt, deterministic echo
 * fallback for dev/CI/offline — see ADR-025). Stored as jsonb; pgvector is the
 * Supabase-prod drop-in (ADR-024).
 */
let gateway: EmbeddingGateway | undefined;

export function embeddingGateway(): EmbeddingGateway {
  return (gateway ??= EmbeddingGateway.default());
}

/** Batch-embed texts through the configured provider (with echo fallback). */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  return (await embeddingGateway().embed(texts)).vectors;
}

/** Cosine similarity. Vectors are L2-normalized, so this is the dot product. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
