import type {
  OpportunityStatus,
  TransactionStatus,
  SettlementStatus,
  ApprovalStatus,
  MissionStatus,
} from "@opportunity-os/contracts";
import type { Tone } from "./theme";

/**
 * Maps a domain lifecycle status onto a semantic {@link Tone}. Covers the
 * Opportunity, Transaction and Settlement machines (§6.7/§6.11/§20) plus the
 * Approval and Mission statuses the console renders. Accepts any string so the
 * console degrades gracefully for values added server-side later.
 */
export type KnownStatus =
  | OpportunityStatus
  | TransactionStatus
  | SettlementStatus
  | ApprovalStatus
  | MissionStatus;

const STATUS_TONE: Record<string, Tone> = {
  // OpportunityStatus (§6.7)
  candidate: "neutral",
  qualified: "info",
  awaiting_approval: "warning",
  approved: "success",
  rejected: "danger",
  expired: "neutral",
  executing: "progress",
  closed: "neutral",
  // TransactionStatus (§6.11)
  proposed: "neutral",
  agreed: "info",
  funding: "warning",
  funded: "info",
  fulfilling: "progress",
  disputed: "danger",
  settled: "success",
  cancelled: "danger",
  // ApprovalStatus
  pending: "warning",
  modified: "info",
  review: "progress",
  // MissionStatus
  draft: "neutral",
  active: "success",
  paused: "warning",
  archived: "neutral",
  completed: "success",
  // SettlementStatus (§20)
  DRAFT: "neutral",
  AWAITING_FUNDING_APPROVAL: "warning",
  FUNDING_PENDING: "warning",
  FUNDED: "info",
  MILESTONE_PENDING: "progress",
  MILESTONE_VERIFIED: "info",
  AWAITING_RELEASE_APPROVAL: "warning",
  RELEASE_PENDING: "warning",
  PARTIALLY_SETTLED: "progress",
  DISPUTED: "danger",
  FROZEN: "danger",
  SETTLED: "success",
};

export function statusTone(status: KnownStatus | string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

/** Human-friendly label: `awaiting_approval` -> `Awaiting approval`. */
export function statusLabel(status: string): string {
  const spaced = status.replace(/[_-]+/g, " ").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
