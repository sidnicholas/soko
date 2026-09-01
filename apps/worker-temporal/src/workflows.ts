import { proxyActivities, sleep, defineSignal, setHandler, condition } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { DiscoveryInput } from "./activities";

const { runDiscoveryCycle } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

const { requestApprovalActivity, executeProposalActivity } = proxyActivities<typeof activities>({
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

/** §14/§11.2 — the human approval decision delivered to a waiting execution workflow. */
export interface ApprovalDecisionSignal {
  approved: boolean;
  /** Approval token minted by the API on approve; required to execute. */
  token?: string;
  decidedBy?: string;
}
export const approvalSignal = defineSignal<[ApprovalDecisionSignal]>("approval");

export interface OpportunityExecutionInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  requestedByAgent: string;
  approvalTimeoutMinutes: number;
}

export interface OpportunityExecutionResult {
  status: "executed" | "rejected" | "expired";
  approvalId: string;
  transactionId?: string;
}

/**
 * §11.2 Opportunity Execution Workflow — request a human gate, then WAIT for
 * the approval signal (bounded by the approval timeout). On approve, execute
 * the gated proposal via a token-verified activity; on reject/timeout, do
 * nothing. No outbound/binding action happens without the human signal.
 */
export async function opportunityExecutionWorkflow(input: OpportunityExecutionInput): Promise<OpportunityExecutionResult> {
  let decision: ApprovalDecisionSignal | undefined;
  setHandler(approvalSignal, (d) => {
    decision = d;
  });

  const { approvalId } = await requestApprovalActivity({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
    requestedByAgent: input.requestedByAgent,
    approvalTimeoutMinutes: input.approvalTimeoutMinutes,
  });

  const decided = await condition(() => decision !== undefined, `${input.approvalTimeoutMinutes} minutes`);
  if (!decided) return { status: "expired", approvalId };
  if (!decision!.approved) return { status: "rejected", approvalId };

  const { transactionId } = await executeProposalActivity({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
    decidedBy: decision!.decidedBy ?? "operator",
    token: decision!.token ?? "",
  });
  return { status: "executed", approvalId, transactionId };
}
