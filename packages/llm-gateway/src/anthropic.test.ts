import { describe, it, expect } from "vitest";
import { anthropicUsd } from "./anthropic";
import { extractJson } from "./index";

describe("anthropicUsd", () => {
  it("prices by the model that served the response", () => {
    // Haiku 4.5: $1 in / $5 out per MTok.
    expect(anthropicUsd("claude-haiku-4-5", { input_tokens: 1_000_000, output_tokens: 200_000 })).toBeCloseTo(2, 6);
    // Sonnet 5.5: $2 in / $10 out; cache reads $0.20, cache writes 1.25x input.
    expect(
      anthropicUsd("claude-sonnet-5-5", { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 100_000 }),
    ).toBeCloseTo(0.2 + 0.1 + 0.2 + 0.25, 6);
  });
  it("falls back to the highest known price for an unknown model", () => {
    expect(anthropicUsd("claude-something-new", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(4);
  });
});

describe("extractJson", () => {
  it("reads JSON wrapped in prose or code fences", () => {
    expect(extractJson('Here you go:\n```json\n{"leads": []}\n```')).toEqual({ leads: [] });
    expect(() => extractJson("no json here")).toThrow("no JSON");
  });
});

describe("LlmGateway.preflight", () => {
  it("collects each provider's check and skips providers without one", async () => {
    const { LlmGateway } = await import("./index");
    const good = { name: "good", preflight: async () => ({ ok: true as const }), complete: async () => ({ text: "", inputTokens: 0, outputTokens: 0, usd: 0, model: "x" }) };
    const bad = {
      name: "bad",
      preflight: async () => ({ ok: false as const, reason: "auth" as const, message: "invalid x-api-key" }),
      complete: async () => ({ text: "", inputTokens: 0, outputTokens: 0, usd: 0, model: "x" }),
    };
    const gateway = new LlmGateway([good, bad]);
    expect(gateway.hasRealProvider()).toBe(true);
    expect(await gateway.preflight()).toEqual([
      { provider: "good", result: { ok: true } },
      { provider: "bad", result: { ok: false, reason: "auth", message: "invalid x-api-key" } },
    ]);
    expect(new LlmGateway([]).hasRealProvider()).toBe(false);
  });
});
