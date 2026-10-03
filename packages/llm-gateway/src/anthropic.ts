import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "./index";

/** First-party API rates, USD per million tokens (input, output, cache read). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};
const UNKNOWN_MODEL_PRICE = PRICES["claude-opus-5-5"]!;

/** Cost of one response from its usage block, priced by the model that actually served it. */
export function anthropicUsd(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
  const price = PRICES[model] ?? Object.entries(PRICES).find(([id]) => model.startsWith(id))?.[1] ?? UNKNOWN_MODEL_PRICE;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (usage.input_tokens * price.input + cacheWrite * price.input * 1.25 + cacheRead * price.cacheRead + usage.output_tokens * price.output) / 1_000_000
  );
}

export interface AnthropicProviderOptions {
  /** Gateway-facing provider name, e.g. "anthropic-fast". */
  name: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  /** Thinking depth on models that take `output_config.effort` (not Haiku 4.5). */
  effort?: "low" | "medium" | "high";
  /** Server-side refusal fallback (Claude API only; not used for Haiku). */
  refusalFallback?: boolean;
}

/**
 * §18 — Claude via the official SDK behind the gateway's provider interface.
 * Prompts carry untrusted connector/search content already fenced by the
 * gateway (§13.3); this class only transports and prices.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.name = opts.name;
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2 });
  }

  async complete(req: { system?: string; prompt: string; timeoutMs: number }) {
    const response = await this.client.beta.messages.create(
      {
        model: this.opts.model,
        max_tokens: this.opts.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
        ...(this.opts.effort ? { output_config: { effort: this.opts.effort } } : {}),
        ...(this.opts.refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { timeout: req.timeoutMs },
    );
    if (response.stop_reason === "refusal") throw new Error(`${this.opts.model} declined the request`);
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      usd: anthropicUsd(response.model, response.usage),
      model: response.model,
    };
  }
}
