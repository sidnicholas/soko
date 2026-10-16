import { getConfig } from "@opportunity-os/config";
import { makeBraveSearch, makeSerperSearch, type SearchProvider } from "@opportunity-os/connectors-sdk";
import { closeDb } from "@opportunity-os/db";
import { runIntelCycle, type Lane } from "@opportunity-os/intel";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-intel");

/**
 * AIOOS opportunity-intelligence sweep (docs/Opportunity_OS_AIOOS_Master_Prompt.md).
 * Runs once and exits — scheduled as a Railway cron service. Needs a key for
 * the chosen search provider (INTEL_SEARCH_PROVIDER) and a real model
 * (ANTHROPIC_API_KEY or a compat tier); without either it logs and exits
 * cleanly (keyless dev). Spend is capped per UTC day by INTEL_DAILY_BUDGET_USD
 * across all runs.
 */
async function main(): Promise<number> {
  const cfg = getConfig();
  const search = searchProvider(cfg.intel);
  const llm = LlmGateway.default();
  if (!search || !llm.hasRealProvider()) {
    log.warn(
      { searchProvider: cfg.intel.searchProvider, search: Boolean(search), llm: llm.hasRealProvider() },
      "intel.not_configured — set the key for INTEL_SEARCH_PROVIDER (BRAVE_SEARCH_API_KEY or SERPER_API_KEY) and ANTHROPIC_API_KEY or a compat LLM tier",
    );
    return 0;
  }
  // Free check before any paid search: an expired/revoked key would otherwise
  // pay for every search in the run and then fail every model call.
  const failed = (await llm.preflight()).filter((c) => !c.result.ok);
  if (failed.length > 0) {
    const fatal = failed.some((c) => !c.result.ok && c.result.reason !== "transient");
    log.error({ failed }, fatal ? "intel.llm_preflight_failed — fix the LLM key / model; run skipped before any spend" : "intel.llm_unreachable — run skipped before any spend; next run retries");
    // Non-zero only for problems a person must fix, so Railway marks the run failed.
    return fatal ? 1 : 0;
  }
  const result = await runIntelCycle({
    search,
    llm,
    estimates: { detectionUsd: cfg.intel.detectionEstimateUsd, assessmentUsd: cfg.intel.assessmentEstimateUsd },
    dailyBudgetUsd: cfg.intel.dailyBudgetUsd,
    runsPerDay: cfg.intel.runsPerDay,
    queriesPerRun: cfg.intel.queriesPerRun,
    maxAssessments: cfg.intel.maxAssessments,
    lane: laneArg(),
    counterpartSearches: cfg.intel.counterpartSearches,
    hypothesisChecks: cfg.intel.hypothesisChecks,
  });
  log.info({ runId: result.runId, lane: laneArg(), status: result.status, leads: result.leadsFound, candidates: result.candidates, spentUsd: result.searchUsd + result.llmUsd }, "intel.once.complete");
  return 0;
}

/**
 * `--lane=demand` or `--lane=supply` (PRD v2 FR-02/FR-03): each lane is its own
 * Railway cron, so supply and demand intelligence run on independent schedules.
 * Without the flag a run serves both.
 */
function laneArg(): Lane {
  const arg = process.argv.find((a) => a.startsWith("--lane="))?.slice("--lane=".length);
  if (arg === undefined) return "all";
  if (arg === "demand" || arg === "supply" || arg === "all") return arg;
  throw new Error(`unknown --lane=${arg}; use demand, supply or all`);
}

function searchProvider(intel: ReturnType<typeof getConfig>["intel"]): SearchProvider | undefined {
  const costPerQueryUsd = intel.searchCostPerQueryUsd;
  if (intel.searchProvider === "serper") return intel.serperApiKey ? makeSerperSearch({ apiKey: intel.serperApiKey, costPerQueryUsd }) : undefined;
  return intel.braveApiKey ? makeBraveSearch({ apiKey: intel.braveApiKey, costPerQueryUsd }) : undefined;
}

main()
  .catch((err) => {
    log.error({ err: String(err) }, "intel.run.failed");
    return 1;
  })
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  });
