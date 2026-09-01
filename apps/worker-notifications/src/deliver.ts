import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { listUndeliveredApprovals, markApprovalNotified } from "@opportunity-os/db";

const log = createLogger("worker-notifications:deliver");

export interface ApprovalNotification {
  approvalId: string;
  summary: string;
  riskSummary?: string;
  /** One-time action link the operator opens to decide (§14). */
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

/**
 * Deliver every pending, undelivered approval exactly once, marking each
 * notified so a later sweep will not re-send it (§14). Returns the count sent.
 */
export async function deliverPendingApprovals(): Promise<number> {
  const pending = await listUndeliveredApprovals();
  for (const approval of pending) {
    await deliverApproval({
      approvalId: approval.id,
      summary: approval.human_readable_summary,
      riskSummary: approval.risk_summary ?? undefined,
      actionUrl: `/approvals/${approval.id}`,
    });
    await markApprovalNotified(approval.id);
  }
  if (pending.length > 0) log.info({ delivered: pending.length }, "approvals.delivered");
  return pending.length;
}
