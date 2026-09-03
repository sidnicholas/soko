import type {
  SettlementStatus,
  TransactionStatus,
  OpportunityStatus,
} from "@opportunity-os/contracts";

/**
 * Domain state machines. Every transition must be validated here and paired
 * with a policy check + audit event by the caller (§20, §25).
 */
export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export type TransitionMap<S extends string> = Record<S, readonly S[]>;

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from].includes(to);
}

export function assertTransition<S extends string>(machine: string, map: TransitionMap<S>, from: S, to: S): void {
  if (!canTransition(map, from, to)) throw new InvalidTransitionError(machine, from, to);
}

export function isTerminal<S extends string>(map: TransitionMap<S>, state: S): boolean {
  return map[state].length === 0;
}

/** §20 — progressive settlement state machine. */
export const SETTLEMENT_TRANSITIONS: TransitionMap<SettlementStatus> = {
  DRAFT: ["AWAITING_FUNDING_APPROVAL"],
  AWAITING_FUNDING_APPROVAL: ["FUNDING_PENDING", "FROZEN"],
  FUNDING_PENDING: ["FUNDED", "FROZEN"],
  FUNDED: ["MILESTONE_PENDING", "FROZEN", "REFUNDED"],
  MILESTONE_PENDING: ["MILESTONE_VERIFIED", "DISPUTED", "FROZEN", "REFUNDED"],
  MILESTONE_VERIFIED: ["AWAITING_RELEASE_APPROVAL", "DISPUTED", "REFUNDED"],
  AWAITING_RELEASE_APPROVAL: ["RELEASE_PENDING", "DISPUTED", "REFUNDED"],
  RELEASE_PENDING: ["PARTIALLY_SETTLED", "SETTLED", "DISPUTED"],
  PARTIALLY_SETTLED: ["MILESTONE_PENDING", "SETTLED", "DISPUTED", "REFUNDED"],
  // The reverse edges (MILESTONE_PENDING/MILESTONE_VERIFIED/AWAITING_RELEASE_APPROVAL/
  // RELEASE_PENDING) let a resolved dispute restore the plan to wherever it was
  // disputed from (`resolveDispute`, ST-11 follow-up) instead of only refunding.
  DISPUTED: ["FROZEN", "MILESTONE_PENDING", "MILESTONE_VERIFIED", "AWAITING_RELEASE_APPROVAL", "RELEASE_PENDING", "PARTIALLY_SETTLED", "SETTLED", "REFUNDED"],
  // Reverse edges let `unfreezeSettlementPlan` restore whatever status the
  // plan was frozen from.
  FROZEN: ["DISPUTED", "AWAITING_FUNDING_APPROVAL", "FUNDING_PENDING", "FUNDED", "MILESTONE_PENDING", "SETTLED", "REFUNDED"],
  REFUNDED: [],
  SETTLED: [],
};

export const TRANSACTION_TRANSITIONS: TransitionMap<TransactionStatus> = {
  proposed: ["agreed", "cancelled"],
  agreed: ["funding", "cancelled"],
  funding: ["funded", "cancelled"],
  funded: ["fulfilling", "disputed"],
  fulfilling: ["settled", "disputed"],
  disputed: ["settled", "cancelled"],
  settled: ["closed"],
  closed: [],
  cancelled: [],
};

export const OPPORTUNITY_TRANSITIONS: TransitionMap<OpportunityStatus> = {
  candidate: ["qualified", "rejected", "expired"],
  qualified: ["awaiting_approval", "rejected", "expired"],
  awaiting_approval: ["approved", "rejected", "expired"],
  approved: ["executing", "expired"],
  executing: ["closed", "rejected"],
  rejected: [],
  expired: [],
  closed: [],
};

/**
 * §14 — an approval is invalidated when any material term changes after it was
 * granted. Returns the list of changed material fields (empty = still valid).
 */
export const MATERIAL_TERM_FIELDS = [
  "counterparty",
  "amount",
  "currency",
  "asset",
  "delivery_deadline",
  "settlement_address",
  "fee",
  "quantity",
  "scope",
  "risk_classification",
] as const;

export type MaterialTerm = (typeof MATERIAL_TERM_FIELDS)[number];

export function materialTermsChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): MaterialTerm[] {
  const changed: MaterialTerm[] = [];
  for (const field of MATERIAL_TERM_FIELDS) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changed.push(field);
  }
  return changed;
}

export function approvalStillValid(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): boolean {
  return materialTermsChanged(before, after).length === 0;
}
