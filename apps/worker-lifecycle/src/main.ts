import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-lifecycle");

/**
 * §3.1(9)/§11.1(10) — availability/lifecycle refresh. Periodically re-verifies
 * demand/supply freshness and expires stale records. The DB scan is wired to
 * @opportunity-os/db repositories once a database is available; the loop below
 * is the durable scheduler skeleton.
 */
async function refreshCycle(): Promise<void> {
  log.info("lifecycle.refresh.cycle");
}

async function main(): Promise<void> {
  const intervalMs = getConfig().policy.missionRefreshIntervalMinutes * 60_000;
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ intervalMs }, "lifecycle worker started");
  while (running) {
    await refreshCycle();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "lifecycle worker crashed");
  process.exitCode = 1;
});
