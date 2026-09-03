import { Logger } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { getConfig } from "@opportunity-os/config";

const logger = new Logger("SettlementTimer");
let client: Client | undefined;

async function temporalClient(): Promise<Client> {
  if (!client) {
    const cfg = getConfig();
    const connection = await Connection.connect({ address: cfg.temporal.address });
    client = new Client({ connection, namespace: cfg.temporal.namespace });
  }
  return client;
}

/**
 * Start the durable settlement-timer workflow (ST-13/WF-3, worker-temporal's
 * `settlementMilestoneTimerWorkflow`) for a milestone that carries an
 * optimistic/deadman window. Passed by workflow-type name, not imported — the
 * same shape `startOpportunityExecution` uses (apps/worker-temporal/src/client.ts)
 * — so this app never depends on the worker app's code, only on Temporal itself.
 *
 * Best-effort: Temporal is a durability layer for these windows, not the
 * source of truth (release decisions execute synchronously regardless via
 * `SettlementService.release()`/`refund()`), so a Temporal outage must not
 * block milestone creation — it only means the auto_refund/auto_release
 * windows won't fire until the workflow is (re)started.
 */
export async function startSettlementMilestoneTimer(milestoneId: string): Promise<void> {
  try {
    const cfg = getConfig();
    const c = await temporalClient();
    await c.workflow.start("settlementMilestoneTimerWorkflow", {
      taskQueue: cfg.temporal.taskQueue,
      workflowId: `settlement-timer:${milestoneId}`,
      args: [{ milestoneId }],
    });
  } catch (err) {
    logger.warn(`could not start settlement timer for milestone ${milestoneId}: ${String(err)}`);
  }
}
