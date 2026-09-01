import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { deliverPendingApprovals } from "./deliver";

const log = createLogger("worker-notifications");

/**
 * §14 — polls for pending, undelivered approval requests and delivers them to
 * Telegram/email. DB-driven so it needs no message bus in V1 (see ADR-019).
 */
async function main(): Promise<void> {
  getConfig();
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));
  log.info("notifications worker started");
  while (running) {
    try {
      await deliverPendingApprovals();
    } catch (err) {
      log.error({ err: String(err) }, "approval.delivery.failed");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5_000);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "notifications worker crashed");
  process.exitCode = 1;
});
