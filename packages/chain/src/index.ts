import { createHash } from "node:crypto";
import type { Money, SettlementPlan } from "@opportunity-os/contracts";
import type {
  ApprovedSettlement,
  ExecutionResult,
  PreparedSettlement,
  ProviderSettlementStatus,
  RailCapabilities,
  RefundResult,
  SettlementRail,
} from "@opportunity-os/settlement";

/** §19.4 — only hashes/attestations go on-chain; PII and terms stay off-chain. */
function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeTermsHash(terms: unknown): string {
  return canonicalHash(terms);
}

export function computeMilestoneHash(milestone: unknown): string {
  return canonicalHash(milestone);
}

/** §19.4/§21 — the minimal, private-data-free payload eligible for anchoring. */
export interface AnchorPayload {
  transactionId: string;
  termsHash: string;
  milestoneHashes: string[];
  releaseAttestations: string[];
  settlementTxRefs: string[];
  finalStateProof: string;
}

export function buildAnchorPayload(input: Omit<AnchorPayload, "finalStateProof">): AnchorPayload {
  return { ...input, finalStateProof: canonicalHash(input) };
}

type ContractStatus = "DRAFT" | "FUNDED" | "RELEASING" | "SETTLED" | "DISPUTED" | "FROZEN" | "REFUNDED";

interface MilestoneState {
  sequence: number;
  hash: string;
  verified: boolean;
  released: boolean;
}

interface ContractState {
  reference: string;
  status: ContractStatus;
  total: Money;
  milestones: MilestoneState[];
  recipients: { address: string; amount: Money }[];
  events: ChainEvent[];
}

export interface ChainEvent {
  reference: string;
  type: "funded" | "milestone_verified" | "released" | "split" | "disputed" | "frozen" | "refunded";
  at: string;
  data?: Record<string, unknown>;
}

/**
 * §19.3 Programmable blockchain rail — local/testnet reference implementation
 * of milestone state, release authorization, multi-recipient split, event
 * emission, dispute/freeze, and refund. Deterministic and in-memory; a real
 * on-chain contract requires a dedicated security audit before funds (§19.3, §29).
 */
export class ProgrammableSettlementAdapter implements SettlementRail {
  readonly railId = "onchain-programmable";
  readonly family = "onchain_programmable" as const;
  private readonly contracts: Record<string, ContractState> = {};
  private readonly listeners: ((e: ChainEvent) => void)[] = [];

  constructor(private readonly network: string = "local") {}

  onEvent(listener: (e: ChainEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: ChainEvent): void {
    for (const l of this.listeners) l(event);
  }

  capabilities(): RailCapabilities {
    return {
      family: "onchain_programmable",
      supportsMilestones: true,
      supportsMultiRecipient: true,
      supportsRefund: true,
      supportsDispute: true,
      assets: ["USDC", "ETH"],
    };
  }

  async quote(plan: SettlementPlan): Promise<{ railId: string; fee: Money; etaSeconds: number; asset: string }> {
    return { railId: this.railId, fee: { amount: 21_000, currency: plan.asset }, etaSeconds: 30, asset: plan.asset };
  }

  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    const reference = `${this.network}:${plan.id}`;
    this.contracts[reference] = {
      reference,
      status: "DRAFT",
      total: plan.total_amount,
      milestones: [],
      recipients: [],
      events: [],
    };
    return { railId: this.railId, reference };
  }

  fund(reference: string): void {
    const c = this.require(reference);
    if (c.status !== "DRAFT") throw new Error(`cannot fund from ${c.status}`);
    c.status = "FUNDED";
    this.record(c, { reference, type: "funded", at: now() });
  }

  addMilestone(reference: string, sequence: number, milestone: unknown): string {
    const c = this.require(reference);
    const hash = computeMilestoneHash(milestone);
    c.milestones.push({ sequence, hash, verified: false, released: false });
    return hash;
  }

  verifyMilestone(reference: string, sequence: number): void {
    const m = this.milestone(reference, sequence);
    m.verified = true;
    this.record(this.require(reference), { reference, type: "milestone_verified", at: now(), data: { sequence } });
  }

  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    const c = this.require(approved.reference);
    if (c.status === "FROZEN" || c.status === "DISPUTED") {
      return { railId: this.railId, externalRef: approved.reference, status: "failed" };
    }
    if (c.status === "DRAFT") this.fund(approved.reference);
    c.status = "RELEASING";
    if (approved.recipients?.length) {
      c.recipients = approved.recipients.map((r) => ({ address: r.address, amount: r.amount }));
      this.record(c, { reference: approved.reference, type: "split", at: now(), data: { recipients: c.recipients.length } });
    }
    for (const m of c.milestones) m.released = true;
    c.status = "SETTLED";
    const externalRef = `0x${canonicalHash({ ref: approved.reference, token: approved.approvalTokenHash }).slice(0, 40)}`;
    this.record(c, { reference: approved.reference, type: "released", at: now(), data: { externalRef } });
    const recipients = approved.recipients?.map((r) => ({
      address: r.address,
      amount: r.amount,
      externalRef: `0x${canonicalHash({ ref: approved.reference, to: r.address }).slice(0, 40)}`,
    }));
    return { railId: this.railId, externalRef, status: "confirmed", ...(recipients ? { recipients } : {}) };
  }

  async status(ref: string): Promise<ProviderSettlementStatus> {
    const c = this.contracts[ref];
    if (!c) return { status: "failed" };
    if (c.status === "SETTLED") return { status: "confirmed", externalRef: ref };
    if (c.status === "REFUNDED") return { status: "refunded", externalRef: ref };
    return { status: "pending", externalRef: ref };
  }

  async dispute(reference: string): Promise<void> {
    const c = this.require(reference);
    c.status = "DISPUTED";
    this.record(c, { reference, type: "disputed", at: now() });
  }

  async freeze(reference: string): Promise<void> {
    const c = this.require(reference);
    c.status = "FROZEN";
    this.record(c, { reference, type: "frozen", at: now() });
  }

  async refund(ref: string, _amount: Money): Promise<RefundResult> {
    const c = this.contracts[ref];
    if (!c) return { externalRef: ref, status: "failed" };
    c.status = "REFUNDED";
    this.record(c, { reference: ref, type: "refunded", at: now() });
    return { externalRef: `refund:${ref}`, status: "refunded" };
  }

  events(reference: string): readonly ChainEvent[] {
    return this.contracts[reference]?.events ?? [];
  }

  private record(c: ContractState, event: ChainEvent): void {
    c.events.push(event);
    this.emit(event);
  }

  private require(reference: string): ContractState {
    const c = this.contracts[reference];
    if (!c) throw new Error(`unknown settlement contract: ${reference}`);
    return c;
  }

  private milestone(reference: string, sequence: number): MilestoneState {
    const m = this.require(reference).milestones.find((x) => x.sequence === sequence);
    if (!m) throw new Error(`unknown milestone ${sequence} on ${reference}`);
    return m;
  }
}

function now(): string {
  return new Date().toISOString();
}
