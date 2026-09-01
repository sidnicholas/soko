import { describe, it, expect } from "vitest";
import { LlmGateway, type LlmProvider } from "@opportunity-os/llm-gateway";
import { draftNegotiation, templateDraft, type NegotiationContext } from "./draft";

const buyCtx: NegotiationContext = {
  side: "buy",
  itemTitle: "Refurbished 27in 4K monitor",
  itemDescription: "Grade A, 12mo warranty",
  targetPriceMinor: 18900,
  maxAmountMinor: 22000,
  currency: "USD",
};

describe("templateDraft", () => {
  it("drafts a buy-side inquiry then a priced, ceiling-aware offer", () => {
    const msgs = templateDraft(buyCtx);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.intent).toBe("opening_inquiry");
    expect(msgs[1]!.intent).toBe("price_proposal");
    expect(msgs[1]!.body).toContain("USD 189.00");
    expect(msgs[1]!.body).toContain("USD 220.00");
  });

  it("drafts a single sell-side offer", () => {
    const msgs = templateDraft({ ...buyCtx, side: "sell" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.intent).toBe("opening_offer");
    expect(msgs[0]!.body).toContain("USD 189.00");
  });
});

describe("draftNegotiation", () => {
  it("falls back to the template with the echo dev provider", async () => {
    const res = await draftNegotiation(buyCtx);
    expect(res.source).toBe("template");
    expect(res.messages.length).toBeGreaterThan(0);
    expect(res.approvedBounds).toEqual({ targetPriceMinor: 18900, maxAmountMinor: 22000, currency: "USD" });
  });

  it("uses the LLM path when the provider returns schema-valid JSON", async () => {
    const provider: LlmProvider = {
      name: "echo",
      async complete() {
        return {
          text: JSON.stringify({ messages: [{ intent: "opening_inquiry", subject: "Hi", body: "Drafted body" }] }),
          inputTokens: 5,
          outputTokens: 5,
          usd: 0,
          model: "mock-1",
        };
      },
    };
    const res = await draftNegotiation(buyCtx, new LlmGateway([provider]));
    expect(res.source).toBe("llm");
    expect(res.messages[0]!.body).toBe("Drafted body");
    expect(res.telemetry?.model).toBe("mock-1");
  });
});
