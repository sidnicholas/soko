import { Logger } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { getConfig } from "@opportunity-os/config";
import type { DiscoveryDemand } from "@opportunity-os/discovery";

const logger = new Logger("MissionDiscoveryWorkflow");
let client: Client | undefined;

async function temporalClient(): Promise<Client> {
  if (!client) {
    const cfg = getConfig();
    const connection = await Connection.connect({ address: cfg.temporal.address });
    client = new Client({ connection, namespace: cfg.temporal.namespace });
  }
  return client;
}

function workflowId(missionId: string): string {
  return `mission-discovery:${missionId}`;
}

/**
 * Start the durable `missionDiscoveryWorkflow` (worker-temporal) for a mission.
 * By workflow-type name, not an import of worker-temporal's code — same shape
 * as the settlement timer's starter (apps/api/src/settlement/temporal.ts).
 *
 * Returns the workflow id on success, or `null` if Temporal is unreachable —
 * the caller must NOT record a workflow id in that case, so the mission stays
 * covered by worker-lifecycle's own sweep (`listActiveMissionsForDiscovery`
 * excludes missions with a recorded id; a failed start records nothing).
 */
export async function startMissionDiscovery(input: {
  missionId: string;
  demand: DiscoveryDemand;
  refreshIntervalMinutes: number;
}): Promise<string | null> {
  try {
    const cfg = getConfig();
    const c = await temporalClient();
    const id = workflowId(input.missionId);
    await c.workflow.start("missionDiscoveryWorkflow", {
      taskQueue: cfg.temporal.taskQueue,
      workflowId: id,
      args: [{ missionId: input.missionId, query: "", demand: input.demand, refreshIntervalMinutes: input.refreshIntervalMinutes }],
    });
    return id;
  } catch (err) {
    logger.warn(`could not start discovery workflow for mission ${input.missionId}: ${String(err)}`);
    return null;
  }
}

/** Best-effort forward of pause/resume/archive to a mission's running workflow, if any. */
export async function signalMissionWorkflow(missionWorkflowId: string, action: "pause" | "resume" | "archive"): Promise<void> {
  try {
    const c = await temporalClient();
    await c.workflow.getHandle(missionWorkflowId).signal(action);
  } catch (err) {
    logger.warn(`could not signal ${action} to mission workflow ${missionWorkflowId}: ${String(err)}`);
  }
}
