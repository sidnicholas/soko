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

const { checkMilestoneTimerActivity } = proxyActivities<typeof activities>({
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

export interface SettlementMilestoneTimerInput {
  milestoneId: string;
}

export interface SettlementMilestoneTimerResult {
  action: "none" | "held" | "refunded" | "released" | "pending";
}

/**
 * §20/ST-13 Settlement Milestone Timer Workflow — the durable half of the
 * release engine's optimistic/deadman windows (packages/escrow/src/release.ts).
 * Sleeps to the next relevant instant, re-checks real state, and acts
 * (auto-refund on deadman, auto-release on an elapsed optimistic window below
 * threshold); a disputed plan or an above-threshold optimistic release needs a
 * human, so the workflow reports "held" and stops rather than guessing (§13.5).
 * An async rail (e.g. an on-chain transfer) reports "pending" and stops too —
 * confirming it is a webhook's job now, not this workflow's.
 */
export async function settlementMilestoneTimerWorkflow(
  input: SettlementMilestoneTimerInput,
): Promise<SettlementMilestoneTimerResult> {
  for (;;) {
    const result = await checkMilestoneTimerActivity(input.milestoneId);
    if (result.action !== "waiting") return { action: result.action };

    const now = Date.now();
    const nextWakeMs = [result.optimisticAfterIso, result.deadmanAtIso]
      .filter((iso): iso is string => Boolean(iso))
      .map((iso) => new Date(iso).getTime())
      .filter((t) => t > now)
      .reduce((min, t) => Math.min(min, t), Infinity);
    if (!Number.isFinite(nextWakeMs)) return { action: "none" };

    await sleep(nextWakeMs - now);
  }
}
