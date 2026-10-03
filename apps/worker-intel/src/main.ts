import { getConfig } from "@opportunity-os/config";
import { makeBraveSearch } from "@opportunity-os/connectors-sdk";
import { closeDb } from "@opportunity-os/db";
import { runIntelCycle } from "@opportunity-os/intel";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-intel");

/**
 * AIOOS opportunity-intelligence sweep (docs/Opportunity_OS_AIOOS_Master_Prompt.md).
 * Runs once and exits — scheduled as a Railway cron service. Needs a search key
 * and ANTHROPIC_API_KEY; without either it logs and exits cleanly (keyless dev).
 * Spend is capped per UTC day by INTEL_DAILY_BUDGET_USD across all runs.
 */
async function main(): Promise<number> {
  const cfg = getConfig();
  if (!cfg.intel.braveApiKey || !cfg.llm.anthropicKey) {
    log.warn({ search: Boolean(cfg.intel.braveApiKey), llm: Boolean(cfg.llm.anthropicKey) }, "intel.not_configured — set BRAVE_SEARCH_API_KEY and ANTHROPIC_API_KEY");
    return 0;
  }
  const llm = LlmGateway.default();
  // Free check before any paid search: an expired/revoked key would otherwise
  // pay for every search in the run and then fail every model call.
  const failed = (await llm.preflight()).filter((c) => !c.result.ok);
  if (failed.length > 0) {
    const fatal = failed.some((c) => !c.result.ok && c.result.reason !== "transient");
    log.error({ failed }, fatal ? "intel.llm_preflight_failed — fix ANTHROPIC_API_KEY / model; run skipped before any spend" : "intel.llm_unreachable — run skipped before any spend; next run retries");
    // Non-zero only for problems a person must fix, so Railway marks the run failed.
    return fatal ? 1 : 0;
  }
  const result = await runIntelCycle({
    search: makeBraveSearch({ apiKey: cfg.intel.braveApiKey }),
    llm,
    dailyBudgetUsd: cfg.intel.dailyBudgetUsd,
    runsPerDay: cfg.intel.runsPerDay,
    queriesPerRun: cfg.intel.queriesPerRun,
    maxAssessments: cfg.intel.maxAssessments,
  });
  log.info({ runId: result.runId, status: result.status, leads: result.leadsFound, candidates: result.candidates, spentUsd: result.searchUsd + result.llmUsd }, "intel.once.complete");
  return 0;
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
