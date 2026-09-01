import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { refreshCycle } from "./refresh";

const log = createLogger("worker-lifecycle");

/**
 * §3.1(9)/§11.1(10) — availability/lifecycle refresh scheduler. For V1 this
 * worker is the active discovery driver: each interval it re-verifies
 * availability and re-drives discovery for all active missions (see ADR-017).
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  const intervalMs = cfg.policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ intervalMs, supplyStaleMinutes: cfg.policy.supplyStaleMinutes }, "lifecycle worker started");
  while (running) {
    try {
      await refreshCycle(cfg.policy.supplyStaleMinutes);
    } catch (err) {
      log.error({ err: String(err) }, "lifecycle.refresh.failed");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "lifecycle worker crashed");
  process.exitCode = 1;
});
