/**
 * Temporal activity surface. Discovery lives in @opportunity-os/discovery so the
 * lifecycle worker and the discovery workflow share one implementation. The
 * execution activities below wrap the same approval/proposal repos + token
 * crypto the HTTP path uses, so the durable path and the synchronous path are
 * behaviourally identical (§11.2, §14).
 */
import { createApproval, getApprovalById, proposeTransaction } from "@opportunity-os/db";
import { verifyApprovalToken } from "@opportunity-os/auth";
import { hashProposalTerms } from "@opportunity-os/audit";
import { getConfig } from "@opportunity-os/config";

export { runDiscoveryCycle } from "@opportunity-os/discovery";
export type { DiscoveryInput, DiscoveryResult, DiscoveryDemand } from "@opportunity-os/discovery";

export interface RequestApprovalActivityInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  requestedByAgent: string;
  approvalTimeoutMinutes: number;
}

/** §11.2(5) create the human-gate request; returns the id the workflow tracks. */
export async function requestApprovalActivity(input: RequestApprovalActivityInput): Promise<{ approvalId: string; payloadHash: string }> {
  const payloadHash = hashProposalTerms({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
  });
  const approval = await createApproval({
    requestedByAgent: input.requestedByAgent,
    actionType: "propose_transaction",
    entityType: "opportunity",
    entityId: input.opportunityId,
    payloadHash,
    humanReadableSummary: `Propose a transaction for opportunity ${input.opportunityId} at ${input.grossAmountMinor} ${input.currency} (minor units)`,
    riskSummary: null,
    expiresAt: new Date(Date.now() + input.approvalTimeoutMinutes * 60_000).toISOString(),
  });
  return { approvalId: approval.id, payloadHash };
}

export interface ExecuteProposalActivityInput {
  opportunityId: string;
  grossAmountMinor: number;
  currency: string;
  decidedBy: string;
  token: string;
}

/**
 * §11.2(7,10) execute the approved action: verify the token cryptographically
 * (same check as the HTTP propose endpoint), confirm the approval is approved,
 * then create the proposed transaction with an audit-backed event. Throws so
 * Temporal surfaces a failed activity if authorization does not hold.
 */
export async function executeProposalActivity(input: ExecuteProposalActivityInput): Promise<{ transactionId: string }> {
  const payloadHash = hashProposalTerms({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
  });
  const verified = verifyApprovalToken(getConfig().security.approvalTokenSecret, input.token, {
    action: "propose_transaction",
    payloadHash,
  });
  if (!verified.ok) throw new Error(`approval token invalid: ${verified.reason}`);

  const approval = await getApprovalById(verified.claims!.approvalId);
  if (!approval || (approval.status !== "approved" && approval.status !== "modified")) {
    throw new Error("approval is not in an approved state");
  }

  const result = await proposeTransaction({
    opportunityId: input.opportunityId,
    grossAmountMinor: input.grossAmountMinor,
    currency: input.currency,
    termsHash: payloadHash,
    decidedBy: input.decidedBy,
  });
  return { transactionId: result.transactionId };
}
