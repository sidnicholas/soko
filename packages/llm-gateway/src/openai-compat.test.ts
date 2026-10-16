import { describe, it, expect } from "vitest";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { LlmGateway } from "./index";
import { OpenAiCompatProvider, compatUsd } from "./openai-compat";

const price = { input: 0.14, output: 0.28 };

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("compatUsd", () => {
  it("prices usage at the configured per-MTok rate", () => {
    expect(compatUsd(price, { prompt_tokens: 1_000_000, completion_tokens: 500_000 })).toBeCloseTo(0.28, 6);
    expect(compatUsd(price, {})).toBe(0);
  });
});

describe("OpenAiCompatProvider", () => {
  it("sends a schema-constrained chat completion and prices the reply", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return reply(200, { model: "deepseek-v4-flash", choices: [{ message: { content: '{"n": 1}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatProvider({ name: "compat-fast", baseUrl: "https://host.example/v1/", apiKey: "k", model: "m", maxTokens: 100, price, fetchImpl });

    const out = await provider.complete({ system: "sys", prompt: "p", timeoutMs: 1000, outputSchema: z4.object({ n: z4.number() }) });

    expect(calls[0]!.url).toBe("https://host.example/v1/chat/completions");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "p" },
    ]);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.schema.required).toEqual(["n"]);
    expect(out).toEqual({ text: '{"n": 1}', inputTokens: 1000, outputTokens: 100, usd: compatUsd(price, { prompt_tokens: 1000, completion_tokens: 100 }), model: "deepseek-v4-flash" });
  });

  it("merges host options into the body and uses the billed cost when the host reports it", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return reply(200, { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.00042 } });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatProvider({
      name: "c", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "deepseek/deepseek-v4-flash", maxTokens: 10, price,
      extraBody: { provider: { require_parameters: true }, usage: { include: true } }, fetchImpl,
    });
    const out = await provider.complete({ prompt: "p", timeoutMs: 1000 });
    expect(body).toMatchObject({ provider: { require_parameters: true }, usage: { include: true }, model: "deepseek/deepseek-v4-flash" });
    expect(out.usd).toBe(0.00042);
  });

  it("resends without response_format when the host rejects it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.response_format ? reply(400, { error: "unsupported" }) : reply(200, { choices: [{ message: { content: "{}" } }], usage: {} });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatProvider({ name: "c", baseUrl: "https://h/v1", apiKey: "k", model: "m", maxTokens: 10, price, fetchImpl });

    const out = await provider.complete({ prompt: "p", timeoutMs: 1000, outputSchema: z4.object({}) });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.response_format).toBeUndefined();
    expect(out.text).toBe("{}");
  });

  it("throws on a host error so the gateway falls back down the chain", async () => {
    const fetchImpl = (async () => reply(500, { error: "boom" })) as unknown as typeof fetch;
    const compat = new OpenAiCompatProvider({ name: "compat-fast", baseUrl: "https://h/v1", apiKey: "k", model: "m", maxTokens: 10, price, fetchImpl });
    const backup = { name: "backup", complete: async () => ({ text: '{"n": 2}', inputTokens: 1, outputTokens: 1, usd: 0.001, model: "b" }) };
    const gw = new LlmGateway([compat, backup], { profiles: { extraction: { providers: ["compat-fast", "backup"], maxUsd: 1, timeoutMs: 1000 } } });

    const res = await gw.runStructured({ taskClass: "extraction", prompt: "p", maxRetries: 0 }, z.object({ n: z.number() }));
    expect(res.value).toEqual({ n: 2 });
    expect(res.telemetry.provider).toBe("backup");
  });

  it("preflight: 401 is an auth failure, a host without /models passes", async () => {
    const make = (status: number) =>
      new OpenAiCompatProvider({ name: "c", baseUrl: "https://h/v1", apiKey: "k", model: "m", maxTokens: 10, price, fetchImpl: (async () => reply(status, {})) as unknown as typeof fetch });
    expect(await make(200).preflight()).toEqual({ ok: true });
    expect(await make(404).preflight()).toEqual({ ok: true });
    expect((await make(401).preflight()).ok).toBe(false);
    expect(await make(401).preflight()).toMatchObject({ reason: "auth" });
    expect(await make(503).preflight()).toMatchObject({ reason: "transient" });
  });
});

describe("LlmGateway.default with a compat tier", () => {
  it("adds the compat provider; Claude stays registered as the fallback", async () => {
    const { resetConfig } = await import("@opportunity-os/config");
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: "a",
        LLM_FAST_PROVIDER: "compat",
        LLM_COMPAT_BASE_URL: "https://h/v1",
        LLM_COMPAT_API_KEY: "k",
        LLM_COMPAT_FAST_MODEL: "m",
        LLM_COMPAT_FAST_PRICE: "0.1,0.2",
      });
      resetConfig();
      const gw = LlmGateway.default();
      const names = (gw as unknown as { providers: Record<string, unknown> }).providers;
      expect(Object.keys(names).sort()).toEqual(["anthropic-fast", "anthropic-reasoning", "compat-fast", "echo"]);
      const profiles = (gw as unknown as { profiles: Record<string, { providers: string[] }> }).profiles;
      expect(profiles.extraction!.providers).toEqual(["compat-fast", "anthropic-fast"]);
      expect(profiles.research_synthesis!.providers).toEqual(["anthropic-reasoning", "anthropic-fast"]);
    } finally {
      process.env = saved;
      resetConfig();
    }
  });
});
