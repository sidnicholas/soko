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
  const result = await runIntelCycle({
    search: makeBraveSearch({ apiKey: cfg.intel.braveApiKey }),
    llm: LlmGateway.default(),
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
