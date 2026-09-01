import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-notifications");

export interface ApprovalNotification {
  approvalId: string;
  summary: string;
  riskSummary?: string;
  /** Signed one-time action link built by the API (§14). */
  actionUrl: string;
}

/**
 * §14 — deliver an approval request to Telegram (primary) and email (fallback).
 * The worker can deliver links but can NEVER execute settlement (§22).
 */
export async function deliverApproval(n: ApprovalNotification): Promise<void> {
  const cfg = getConfig();
  const text = `Approval ${n.approvalId}\n${n.summary}\n${n.riskSummary ?? ""}\nDecide: ${n.actionUrl}`;
  if (cfg.notifications.telegramBotToken && cfg.notifications.telegramChatId) {
    const url = `https://api.telegram.org/bot${cfg.notifications.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.notifications.telegramChatId, text }),
    });
    log.info({ approvalId: n.approvalId, status: res.status }, "telegram.delivered");
    return;
  }
  // Email fallback / dev: log the payload the SMTP adapter would send.
  log.warn({ approvalId: n.approvalId, emailFrom: cfg.notifications.emailFrom, text }, "approval.notification.logged");
}

async function main(): Promise<void> {
  getConfig();
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));
  log.info("notifications worker started");
  while (running) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5_000);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "notifications worker crashed");
  process.exitCode = 1;
});
