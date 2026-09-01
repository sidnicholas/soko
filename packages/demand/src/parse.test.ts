import { describe, it, expect } from "vitest";
import { LlmGateway, type LlmProvider } from "@opportunity-os/llm-gateway";
import { parseDemand } from "./parse";

describe("parseDemand", () => {
  it("falls back to the heuristic when the model yields no usable JSON (echo dev provider)", async () => {
    const res = await parseDemand({ text: "27-inch 4K monitor under $220" });
    expect(res.source).toBe("heuristic");
    expect(res.spec.budget.maximum).toEqual({ amount: 22000, currency: "USD" });
  });

  it("uses the LLM path when the provider returns schema-valid JSON", async () => {
    const spec = {
      what: { description: "vintage guitar" },
      budget: { flexible: false, maximum: { amount: 90000, currency: "USD" } },
      quality: { constraints: [] },
      timing: { urgency: "days" },
      payment: { acceptableMethods: ["card"] },
      fulfillment: { type: "ship" },
      flexibility: { substitutesAllowed: false, negotiableFields: [], nonNegotiables: [] },
      negotiationAuthorization: { mayPrepare: true, maySend: false },
    };
    // Provider named "echo" so the default `extraction` profile routes to it.
    const jsonProvider: LlmProvider = {
      name: "echo",
      async complete() {
        return { text: JSON.stringify(spec), inputTokens: 10, outputTokens: 20, usd: 0, model: "mock-1" };
      },
    };
    const res = await parseDemand({ text: "want a vintage guitar, ~$900" }, new LlmGateway([jsonProvider]));
    expect(res.source).toBe("llm");
    expect(res.spec.what.description).toBe("vintage guitar");
    expect(res.telemetry?.model).toBe("mock-1");
  });

  it("applies form hints over parsed values", async () => {
    const res = await parseDemand({ text: "a desk", hints: { budgetMaxMinor: 15000, urgency: "today" } });
    expect(res.spec.budget.maximum).toEqual({ amount: 15000, currency: "USD" });
    expect(res.spec.budget.flexible).toBe(false);
    expect(res.spec.timing.urgency).toBe("today");
  });
});
