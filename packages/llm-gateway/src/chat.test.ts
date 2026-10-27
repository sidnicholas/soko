import { describe, it, expect } from "vitest";
import { CompletionsChatModel, completionCitations, completionUsd } from "./chat";

const price = { input: 3, output: 15 };

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("completionUsd", () => {
  it("uses the cost the host reports, as a number or Perplexity's breakdown", () => {
    expect(completionUsd({ price }, { prompt_tokens: 1000, completion_tokens: 100, cost: 0.02 })).toBe(0.02);
    expect(completionUsd({ price }, { prompt_tokens: 1000, completion_tokens: 100, cost: { total_cost: 0.011 } })).toBe(0.011);
  });

  it("otherwise prices tokens and adds the request fee", () => {
    expect(completionUsd({ price, requestFeeUsd: 0.006 }, { prompt_tokens: 1_000_000, completion_tokens: 100_000 })).toBeCloseTo(3 + 1.5 + 0.006, 6);
    expect(completionUsd({ price }, undefined)).toBe(0);
  });
});

describe("completionCitations", () => {
  it("keeps Perplexity's citation order and adds titles from its search results", () => {
    expect(
      completionCitations({ citations: ["https://a.example", "https://b.example", "https://a.example"], search_results: [{ url: "https://b.example", title: "B Corp" }] }),
    ).toEqual([{ url: "https://a.example" }, { url: "https://b.example", title: "B Corp" }]);
  });

  it("falls back to the search results, and is empty for hosts without either", () => {
    expect(completionCitations({ search_results: [{ url: "https://c.example", title: "C" }, {}] })).toEqual([{ url: "https://c.example", title: "C" }]);
    expect(completionCitations({})).toEqual([]);
  });
});

describe("CompletionsChatModel", () => {
  it("sends the system prompt and the whole conversation, and returns text, citations and cost", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return reply(200, { model: "sonar-pro", choices: [{ message: { content: "Acme Ltd [1]" } }], citations: ["https://acme.example"], usage: { prompt_tokens: 2000, completion_tokens: 50, cost: { total_cost: 0.0145 } } });
    }) as unknown as typeof fetch;
    const m = new CompletionsChatModel({ id: "perplexity", label: "Perplexity", purpose: "p", baseUrl: "https://api.perplexity.ai/", apiKey: "k", model: "sonar-pro", price, maxTokens: 4000, tokenField: "max_tokens", fetchImpl });

    const out = await m.chat({ system: "sys", turns: [{ role: "user", content: "who?" }, { role: "assistant", content: "Acme" }, { role: "user", content: "contact?" }], timeoutMs: 1000 });

    expect(calls[0]!.url).toBe("https://api.perplexity.ai/chat/completions");
    expect(calls[0]!.body).toMatchObject({ model: "sonar-pro", max_tokens: 4000 });
    expect((calls[0]!.body.messages as { role: string }[]).map((t) => t.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(out).toEqual({ text: "Acme Ltd [1]", citations: [{ url: "https://acme.example" }], inputTokens: 2000, outputTokens: 50, usd: 0.0145, model: "sonar-pro" });
  });

  it("uses max_completion_tokens and extra fields for OpenAI reasoning models", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply(200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }) as unknown as typeof fetch;
    const m = new CompletionsChatModel({ id: "openai", label: "OpenAI", purpose: "p", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5", price: { input: 1.25, output: 10 }, maxTokens: 16000, tokenField: "max_completion_tokens", extraBody: { reasoning_effort: "low" }, fetchImpl });
    const out = await m.chat({ system: "s", turns: [{ role: "user", content: "q" }], timeoutMs: 1000 });
    expect(body).toMatchObject({ model: "gpt-5", max_completion_tokens: 16000, reasoning_effort: "low" });
    expect(body).not.toHaveProperty("max_tokens");
    expect(out.model).toBe("gpt-5");
  });

  it("throws on an HTTP error with the host's message", async () => {
    const fetchImpl = (async () => reply(401, { error: "bad key" })) as unknown as typeof fetch;
    const m = new CompletionsChatModel({ id: "openai", label: "OpenAI", purpose: "p", baseUrl: "https://h", apiKey: "k", model: "gpt-5", price, maxTokens: 1, tokenField: "max_tokens", fetchImpl });
    await expect(m.chat({ system: "s", turns: [{ role: "user", content: "q" }], timeoutMs: 1000 })).rejects.toThrow(/OpenAI 401/);
  });
});

describe("You.com Inference Router", () => {
  const web_results = {
    searches: [
      { results: [{ citation: 2, url: "https://b.example", title: "B" }, { citation: 1, url: "https://a.example", title: "A" }] },
      { results: [{ citation: 3, url: "https://a.example", title: "A again" }] },
    ],
  };

  it("lists sources in citation order without duplicates", () => {
    expect(completionCitations({ web_results })).toEqual([{ url: "https://a.example", title: "A" }, { url: "https://b.example", title: "B" }]);
  });

  it("declares the web_search tool and charges per search it ran", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply(200, { model: "kimi-k3", choices: [{ message: { content: "Acme [1]" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, web_results });
    }) as unknown as typeof fetch;
    const m = new CompletionsChatModel({
      id: "youcom", label: "You.com", purpose: "p", baseUrl: "https://api.you.com/v1", apiKey: "k", model: "kimi-k3", price: { input: 2.85, output: 14.25 },
      perSearchFeeUsd: 0.005, maxTokens: 12000, tokenField: "max_completion_tokens", extraBody: { tools: [{ type: "web_search", count: 8 }] }, fetchImpl,
    });
    const out = await m.chat({ system: "s", turns: [{ role: "user", content: "q" }], timeoutMs: 1000 });
    expect(body).toMatchObject({ model: "kimi-k3", max_completion_tokens: 12000, tools: [{ type: "web_search", count: 8 }] });
    expect(out.usd).toBeCloseTo(2.85 + 2 * 0.005, 6);
    expect(out.citations).toHaveLength(2);
  });
});
