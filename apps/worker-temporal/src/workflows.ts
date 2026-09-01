import { proxyActivities, sleep, defineSignal, setHandler, condition, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { DiscoveryInput } from "./activities";

const { runDiscoveryCycle } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export interface MissionDiscoveryInput extends DiscoveryInput {
  refreshIntervalMinutes: number;
  maxCycles?: number;
}

/**
 * §11.1 Mission Discovery Workflow — parse (upstream) -> schedule connectors ->
 * normalize -> match -> score -> risk -> persist -> notify, then refresh
 * periodically until paused/expired/fulfilled.
 */
export async function missionDiscoveryWorkflow(input: MissionDiscoveryInput): Promise<number> {
  let paused = false;
  let stop = false;
  setHandler(pauseSignal, () => {
    paused = true;
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });
  setHandler(archiveSignal, () => {
    stop = true;
  });

  let total = 0;
  const maxCycles = input.maxCycles ?? Number.MAX_SAFE_INTEGER;
  for (let cycle = 0; cycle < maxCycles && !stop; cycle++) {
    if (!paused) {
      const result = await runDiscoveryCycle(input);
      total += result.opportunitiesPersisted;
    }
    if (cycle + 1 >= maxCycles) break;
    await Promise.race([
      sleep(input.refreshIntervalMinutes * 60_000),
      condition(() => stop),
    ]);
  }
  return total;
}

export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const archiveSignal = defineSignal("archive");

/** §14/§11.2 — human approval decision delivered to a waiting execution workflow. */
export const approvalSignal = defineSignal<[{ approved: boolean; approvalTokenHash: string }]>("approval");

/**
 * §11.2 Opportunity Execution Workflow — reverify, recalc, risk, prepare
 * negotiation, then WAIT for a human approval signal before any outbound action.
 */
export async function opportunityExecutionWorkflow(input: { opportunityId: string; approvalTimeoutMinutes: number }): Promise<string> {
  let decision: { approved: boolean; approvalTokenHash: string } | undefined;
  setHandler(approvalSignal, (d) => {
    decision = d;
  });

  const decided = await condition(() => decision !== undefined, `${input.approvalTimeoutMinutes} minutes`);
  if (!decided || !decision?.approved) return "rejected_or_expired";

  // Approved: the workflow id anchors the audit trail; execution of the
  // outbound/settlement action happens via a gated activity (not shown here).
  return `approved:${workflowInfo().workflowId}:${decision.approvalTokenHash}`;
}
