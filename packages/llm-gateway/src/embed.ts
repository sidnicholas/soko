import type { CostTelemetry } from "@opportunity-os/contracts";
import { getConfig } from "@opportunity-os/config";

/** §18 — a text embedding model. Dim is fixed per model. */
export interface EmbeddingModel {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; usd: number; tokens: number }>;
}

const STOP: Record<string, true> = { the: true, and: true, for: true, with: true, new: true, used: true };

/** Deterministic, offline embedding for dev/CI and the ultimate fallback. */
export class EchoEmbeddingModel implements EmbeddingModel {
  readonly id = "echo";
  constructor(readonly dim = 512) {}
  async embed(texts: string[]): Promise<{ vectors: number[][]; usd: number; tokens: number }> {
    let tokens = 0;
    const vectors = texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const raw of t.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 2 || STOP[raw]) continue;
        tokens++;
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
      return norm === 0 ? v : v.map((x) => x / norm);
    });
    return { vectors, usd: 0, tokens };
  }
}

type EmbeddingApiResponse = { data: { embedding: number[] }[]; usage?: { total_tokens?: number } };

/** OpenAI embeddings; Matryoshka dim via `dimensions` (e.g. text-embedding-3-small @ 512). */
export class OpenAIEmbeddingModel implements EmbeddingModel {
  readonly id: string;
  constructor(private readonly apiKey: string, readonly model: string, readonly dim: number) {
    this.id = `openai:${model}`;
  }
  async embed(texts: string[]): Promise<{ vectors: number[][]; usd: number; tokens: number }> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dim }),
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as EmbeddingApiResponse;
    return { vectors: json.data.map((d) => d.embedding), usd: 0, tokens: json.usage?.total_tokens ?? 0 };
  }
}

/** Voyage embeddings (voyage-3-lite; small dim, strong retrieval price/perf). */
export class VoyageEmbeddingModel implements EmbeddingModel {
  readonly id: string;
  constructor(private readonly apiKey: string, readonly model: string, readonly dim: number) {
    this.id = `voyage:${model}`;
  }
  async embed(texts: string[]): Promise<{ vectors: number[][]; usd: number; tokens: number }> {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, output_dimension: this.dim }),
    });
    if (!res.ok) throw new Error(`voyage embeddings ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as EmbeddingApiResponse;
    return { vectors: json.data.map((d) => d.embedding), usd: 0, tokens: json.usage?.total_tokens ?? 0 };
  }
}

export interface EmbeddingResult {
  vectors: number[][];
  telemetry: CostTelemetry;
}

function telemetry(model: string, tokens: number, usd: number): CostTelemetry {
  return { input_tokens: tokens, output_tokens: 0, cached_tokens: 0, usd, provider: model.split(":")[0], model, retries: 0 };
}

/**
 * §18 embedding gateway: run the configured provider, falling back to the
 * deterministic echo model when it is unavailable or errors — so dev/CI/offline
 * always work. Dim is fixed by the active model; callers must not mix dims.
 */
export class EmbeddingGateway {
  constructor(
    private readonly model: EmbeddingModel,
    private readonly fallback: EmbeddingModel = new EchoEmbeddingModel(model.dim),
  ) {}

  get dim(): number {
    return this.model.dim;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) return { vectors: [], telemetry: telemetry(this.model.id, 0, 0) };
    try {
      const out = await this.model.embed(texts);
      return { vectors: out.vectors, telemetry: telemetry(this.model.id, out.tokens, out.usd) };
    } catch {
      const out = await this.fallback.embed(texts);
      return { vectors: out.vectors, telemetry: telemetry(this.fallback.id, out.tokens, out.usd) };
    }
  }

  static default(): EmbeddingGateway {
    const cfg = getConfig();
    const dim = cfg.llm.embeddingDim;
    const echo = new EchoEmbeddingModel(dim);
    if (cfg.llm.embeddingProvider === "openai" && cfg.llm.openaiKey) {
      return new EmbeddingGateway(new OpenAIEmbeddingModel(cfg.llm.openaiKey, cfg.llm.embeddingModel, dim), echo);
    }
    if (cfg.llm.embeddingProvider === "voyage" && cfg.llm.voyageKey) {
      return new EmbeddingGateway(new VoyageEmbeddingModel(cfg.llm.voyageKey, cfg.llm.embeddingModel, dim), echo);
    }
    return new EmbeddingGateway(echo, echo);
  }
}
