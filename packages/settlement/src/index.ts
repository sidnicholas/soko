import type { Money, RailFamily, SettlementPlan } from "@opportunity-os/contracts";

export * from "./fiat";
export * from "./stablecoin";

/** §19 — the rail-neutral settlement abstraction. Native from day one. */
export interface RailCapabilities {
  family: RailFamily;
  supportsMilestones: boolean;
  supportsMultiRecipient: boolean;
  supportsRefund: boolean;
  supportsDispute: boolean;
  assets: readonly string[];
}

export interface SettlementQuote {
  railId: string;
  fee: Money;
  etaSeconds: number;
  asset: string;
}

export interface PreparedSettlement {
  railId: string;
  reference: string;
}

/**
 * An execution request that has already passed the policy/human gate. The
 * approvalTokenHash MUST match the approved action payload (§14, §22).
 */
export interface ApprovedSettlement {
  railId: string;
  reference: string;
  approvalTokenHash: string;
  amount: Money;
  recipients?: readonly { address: string; amount: Money }[];
}

export interface ExecutionResult {
  railId: string;
  externalRef: string;
  status: "pending" | "confirmed" | "failed";
}

export interface ProviderSettlementStatus {
  status: "pending" | "confirmed" | "failed" | "refunded";
  externalRef?: string;
}

export interface RefundResult {
  externalRef: string;
  status: "pending" | "refunded" | "failed";
}

export interface SettlementRail {
  readonly railId: string;
  readonly family: RailFamily;
  capabilities(): RailCapabilities;
  quote(plan: SettlementPlan): Promise<SettlementQuote>;
  prepare(plan: SettlementPlan): Promise<PreparedSettlement>;
  execute(approved: ApprovedSettlement): Promise<ExecutionResult>;
  status(ref: string): Promise<ProviderSettlementStatus>;
  refund?(ref: string, amount: Money): Promise<RefundResult>;
  /** Best-effort on-rail dispute/freeze signal; DISPUTED/FROZEN is authoritative in the domain state machine regardless (§20). */
  dispute?(ref: string): Promise<void>;
  freeze?(ref: string): Promise<void>;
}

/**
 * Registry + selector. Transactions are never coupled to a single rail (§29);
 * callers select by railId or by family, and every execute demands an
 * approved, hash-matched settlement (§13.5).
 */
export class SettlementService {
  private readonly rails: Record<string, SettlementRail> = {};

  register(rail: SettlementRail): void {
    this.rails[rail.railId] = rail;
  }

  get(railId: string): SettlementRail {
    const rail = this.rails[railId];
    if (!rail) throw new Error(`no settlement rail registered: ${railId}`);
    return rail;
  }

  byFamily(family: RailFamily): SettlementRail[] {
    return Object.values(this.rails).filter((r) => r.family === family);
  }

  async quote(plan: SettlementPlan): Promise<SettlementQuote> {
    return this.get(plan.provider).quote(plan);
  }

  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    return this.get(plan.provider).prepare(plan);
  }

  /** Execute requires a non-empty approval token hash; no self-authorized money (§13.5). */
  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    if (!approved.approvalTokenHash) {
      throw new Error("refusing to execute settlement without an approved action token");
    }
    return this.get(approved.railId).execute(approved);
  }
}
