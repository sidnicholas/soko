import { z as z4 } from "zod/v4";
import type { LlmProvider, PreflightResult } from "./index";

/** USD per million tokens for the configured model; the host's list price. */
export interface TokenPrice {
  input: number;
  output: number;
}

export interface OpenAiCompatProviderOptions {
  /** Gateway-facing provider name, e.g. "compat-fast". */
  name: string;
  /** Chat Completions base URL, e.g. https://api.together.xyz/v1 (no trailing /chat/completions). */
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  price: TokenPrice;
  /**
   * Host-specific request fields merged into every body, e.g. OpenRouter's
   * `{"provider": {"require_parameters": true}, "usage": {"include": true}}`
   * (route only to servers that enforce the schema; return the billed cost).
   */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/** Cost of one response from its usage block at the configured per-MTok price. */
export function compatUsd(price: TokenPrice, usage: { prompt_tokens?: number; completion_tokens?: number }): number {
  return ((usage.prompt_tokens ?? 0) * price.input + (usage.completion_tokens ?? 0) * price.output) / 1_000_000;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  /** `cost`: what the host billed, in USD, when it reports it (OpenRouter with usage accounting). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/**
 * §18 — any host speaking the OpenAI Chat Completions protocol (Together,
 * Groq, DeepSeek, OpenRouter, a self-hosted vLLM, …), so open-weight models
 * can serve gateway task classes at a lower price than Claude. Prompts carry
 * untrusted content already fenced by the gateway (§13.3); this class only
 * transports and prices.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly name: string;
  private readonly doFetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: OpenAiCompatProviderOptions) {
    this.name = opts.name;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  private headers() {
    return { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` };
  }

  private async send(req: { system?: string; prompt: string; timeoutMs: number; outputSchema?: z4.ZodType }, structured: boolean) {
    const body = {
      ...(this.opts.extraBody ?? {}),
      model: this.opts.model,
      max_tokens: this.opts.maxTokens,
      messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }],
      // Schema-constrained output where the host supports it. Hosts differ in
      // how strictly they enforce it, so runStructured still validates.
      ...(structured && req.outputSchema
        ? { response_format: { type: "json_schema", json_schema: { name: "reply", schema: z4.toJSONSchema(req.outputSchema), strict: true } } }
        : {}),
    };
    return this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  }

  /** Free credential check (`GET /models`, no tokens billed). A host without that route is not treated as a failure. */
  async preflight(): Promise<PreflightResult> {
    try {
      const res = await this.doFetch(`${this.baseUrl}/models`, { headers: this.headers() });
      if (res.ok || res.status === 404 || res.status === 405) return { ok: true };
      if (res.status === 401) return { ok: false, reason: "auth", message: `${this.name}: 401 from ${this.baseUrl}` };
      if (res.status === 403) return { ok: false, reason: "permission", message: `${this.name}: 403 from ${this.baseUrl}` };
      return { ok: false, reason: "transient", message: `${this.name}: ${res.status} from ${this.baseUrl}` };
    } catch (err) {
      return { ok: false, reason: "transient", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async complete(req: { system?: string; prompt: string; timeoutMs: number; outputSchema?: z4.ZodType }) {
    let res = await this.send(req, true);
    // A host that rejects the response_format (unbilled 400/422): send once
    // more without it; the caller's lenient parser still validates.
    if (req.outputSchema && (res.status === 400 || res.status === 422)) res = await this.send(req, false);
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as ChatCompletion;
    const choice = json.choices?.[0];
    if (choice?.message?.refusal) throw new Error(`${this.opts.model} declined the request`);
    const usage = json.usage ?? {};
    return {
      text: choice?.message?.content ?? "",
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      // The billed cost when the host reports one (it can route to servers at different prices); else the configured price.
      usd: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : compatUsd(this.opts.price, usage),
      model: json.model ?? this.opts.model,
    };
  }
}
