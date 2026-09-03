import { Logger } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { getConfig } from "@opportunity-os/config";

const logger = new Logger("OpportunityExecutionWorkflow");
let client: Client | undefined;

async function temporalClient(): Promise<Client> {
  if (!client) {
    const cfg = getConfig();
    const connection = await Connection.connect({ address: cfg.temporal.address });
    client = new Client({ connection, namespace: cfg.temporal.namespace });
  }
  return client;
}

/** Deterministic workflow id per opportunity — a repeat call is a no-op collision. */
export function opportunityExecutionWorkflowId(opportunityId: string): string {
  return `opp-exec:${opportunityId}`;
}

export interface StartOpportunityExecutionInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  requestedByAgent: string;
  approvalTimeoutMinutes: number;
}

/**
 * Start the durable `opportunityExecutionWorkflow` (worker-temporal) for an
 * opportunity — its first activity creates the approval itself (identical
 * shape to `OpportunityService.requestApproval`'s direct `createApproval`
 * call), so the existing approvals list/decide endpoints work unchanged; only
 * `ApprovalService.decide` additionally signals this workflow (best-effort —
 * `signalOpportunityExecutionDecision` below).
 */
export async function startOpportunityExecutionDurable(input: StartOpportunityExecutionInput): Promise<string> {
  const cfg = getConfig();
  const c = await temporalClient();
  const workflowId = opportunityExecutionWorkflowId(input.opportunityId);
  await c.workflow.start("opportunityExecutionWorkflow", {
    taskQueue: cfg.temporal.taskQueue,
    workflowId,
    args: [input],
  });
  return workflowId;
}

/**
 * Best-effort: deliver a human approval decision to a waiting execution
 * workflow, if one happens to be running for this entity. A normal
 * (non-durable) approval — the default, unwired path — has no matching
 * workflow; the resulting `WorkflowNotFoundError` is expected and swallowed.
 */
export async function signalOpportunityExecutionDecision(
  opportunityId: string,
  decision: { approved: boolean; token?: string; decidedBy?: string },
): Promise<void> {
  try {
    const c = await temporalClient();
    await c.workflow.getHandle(opportunityExecutionWorkflowId(opportunityId)).signal("approval", decision);
  } catch (err) {
    logger.debug(`no execution workflow to signal for opportunity ${opportunityId}: ${String(err)}`);
  }
}
