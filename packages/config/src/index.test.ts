import { describe, it, expect } from "vitest";
import { loadConfig } from "./index";

const compat = {
  LLM_FAST_PROVIDER: "compat",
  LLM_COMPAT_BASE_URL: "https://api.together.xyz/v1",
  LLM_COMPAT_API_KEY: "k",
  LLM_COMPAT_FAST_MODEL: "deepseek-ai/DeepSeek-V4-Flash",
  LLM_COMPAT_FAST_PRICE: "0.14, 0.28",
};

describe("LLM tier and intel search config", () => {
  it("defaults to Claude, Brave and the measured-cost estimates", () => {
    const cfg = loadConfig({});
    expect(cfg.llm.fastProvider).toBe("anthropic");
    expect(cfg.llm.reasoningProvider).toBe("anthropic");
    expect(cfg.intel.searchProvider).toBe("brave");
    expect(cfg.intel.detectionEstimateUsd).toBe(0.006);
    expect(cfg.intel.assessmentEstimateUsd).toBe(0.04);
    // No per-deal capital cap unless one is set.
    expect(cfg.intel.maxCapitalUsd).toBeNull();
    expect(loadConfig({ DEAL_MAX_CAPITAL_USD: "" }).intel.maxCapitalUsd).toBeNull();
    expect(loadConfig({ DEAL_MAX_CAPITAL_USD: "2500" }).intel.maxCapitalUsd).toBe(2500);
  });

  it("parses a compat tier and its price", () => {
    const cfg = loadConfig(compat);
    expect(cfg.llm.fastProvider).toBe("compat");
    expect(cfg.llm.compat.fastPrice).toEqual({ input: 0.14, output: 0.28 });
    expect(cfg.llm.compat.reasoningPrice).toBeUndefined();
  });

  it("refuses a compat tier without its price, so spend caps can't see a free model", () => {
    expect(() => loadConfig({ ...compat, LLM_COMPAT_FAST_PRICE: "" })).toThrow("LLM_COMPAT_FAST_PRICE");
    expect(() => loadConfig({ ...compat, LLM_REASONING_PROVIDER: "compat" })).toThrow("LLM_COMPAT_REASONING_MODEL, LLM_COMPAT_REASONING_PRICE");
    expect(() => loadConfig({ ...compat, LLM_COMPAT_BASE_URL: undefined })).toThrow("LLM_COMPAT_BASE_URL");
  });

  it("parses host options as a JSON object and refuses anything else", () => {
    expect(loadConfig({ ...compat, LLM_COMPAT_EXTRA_BODY: '{"usage":{"include":true}}' }).llm.compat.extraBody).toEqual({ usage: { include: true } });
    expect(() => loadConfig({ ...compat, LLM_COMPAT_EXTRA_BODY: "[1]" })).toThrow("JSON object");
    expect(() => loadConfig({ ...compat, LLM_COMPAT_EXTRA_BODY: "not json" })).toThrow("JSON object");
  });

  it("reads Pipedrive settings, with blank IDs as unset and the domain from a URL", () => {
    const cfg = loadConfig({ PIPEDRIVE_COMPANY_DOMAIN: "https://acme.pipedrive.com/", PIPEDRIVE_PIPELINE_ID: "", PIPEDRIVE_STAGE_ID: "4" });
    expect(cfg.crm.pipedrive).toMatchObject({ companyDomain: "acme", pipelineId: undefined, stageId: 4 });
  });

  it("rejects a malformed price", () => {
    expect(() => loadConfig({ ...compat, LLM_COMPAT_FAST_PRICE: "0.14" })).toThrow("input,output");
    expect(() => loadConfig({ ...compat, LLM_COMPAT_FAST_PRICE: "cheap,0.2" })).toThrow("input,output");
  });

  it("turns graph arbitrage deals off while embeddings are the echo stub", () => {
    expect(loadConfig({}).discovery.graphArbitrageDeals).toBe(false);
    expect(loadConfig({ EMBEDDING_PROVIDER: "voyage" }).discovery.graphArbitrageDeals).toBe(true);
    expect(loadConfig({ GRAPH_ARBITRAGE_DEALS: "on" }).discovery.graphArbitrageDeals).toBe(true);
    expect(loadConfig({ EMBEDDING_PROVIDER: "openai", GRAPH_ARBITRAGE_DEALS: "off" }).discovery.graphArbitrageDeals).toBe(false);
  });

  it("takes Serper and a per-query price override", () => {
    const cfg = loadConfig({ INTEL_SEARCH_PROVIDER: "serper", SERPER_API_KEY: "s", INTEL_SEARCH_COST_PER_QUERY_USD: "0.0008" });
    expect(cfg.intel.searchProvider).toBe("serper");
    expect(cfg.intel.serperApiKey).toBe("s");
    expect(cfg.intel.searchCostPerQueryUsd).toBe(0.0008);
  });
});
