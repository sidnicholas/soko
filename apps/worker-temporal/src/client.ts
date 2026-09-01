import { Client, Connection } from "@temporalio/client";
import { getConfig } from "@opportunity-os/config";
import type { ApprovalDecisionSignal, OpportunityExecutionInput } from "./workflows";

let client: Client | undefined;

/** Process-wide Temporal client (lazily connected). */
export async function getTemporalClient(): Promise<Client> {
  if (!client) {
    const cfg = getConfig();
    const connection = await Connection.connect({ address: cfg.temporal.address });
    client = new Client({ connection, namespace: cfg.temporal.namespace });
  }
  return client;
}

/**
 * Start the durable execution workflow for an opportunity (§11.2). Deterministic
 * workflow id per opportunity so a duplicate start is a no-op collision.
 */
export async function startOpportunityExecution(input: OpportunityExecutionInput): Promise<string> {
  const cfg = getConfig();
  const c = await getTemporalClient();
  const workflowId = `opp-exec:${input.opportunityId}`;
  await c.workflow.start("opportunityExecutionWorkflow", {
    taskQueue: cfg.temporal.taskQueue,
    workflowId,
    args: [input],
  });
  return workflowId;
}

/** Deliver a human approval decision to the waiting execution workflow (§11.2(6)). */
export async function signalApprovalDecision(workflowId: string, decision: ApprovalDecisionSignal): Promise<void> {
  const c = await getTemporalClient();
  await c.workflow.getHandle(workflowId).signal("approval", decision);
}
