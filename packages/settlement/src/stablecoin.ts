import type { Money, SettlementPlan } from "@opportunity-os/contracts";
import type {
  ApprovedSettlement,
  ExecutionResult,
  PreparedSettlement,
  ProviderSettlementStatus,
  RailCapabilities,
  RefundResult,
  SettlementQuote,
  SettlementRail,
} from "./index";

/**
 * §19.2 Stablecoin rail exposed through a provider capability abstraction.
 * Asset/network are configurable. This reference implementation is a
 * deterministic simulation used until a real provider is wired; it keeps the
 * rail interface honest without moving funds.
 */
export class StablecoinRail implements SettlementRail {
  readonly railId = "stablecoin";
  readonly family = "stablecoin" as const;

  constructor(
    private readonly network: string,
    private readonly assets: readonly string[] = ["USDC"],
  ) {}

  capabilities(): RailCapabilities {
    return {
      family: "stablecoin",
      supportsMilestones: true,
      supportsMultiRecipient: true,
      supportsRefund: false,
      supportsDispute: true,
      assets: this.assets,
    };
  }

  async quote(plan: SettlementPlan): Promise<SettlementQuote> {
    // Flat simulated network fee in minor units of the asset.
    return { railId: this.railId, fee: { amount: 5, currency: plan.asset }, etaSeconds: 15, asset: plan.asset };
  }

  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    return { railId: this.railId, reference: `${this.network}:intent:${plan.id}` };
  }

  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    const txHash = `0xsim${simpleHash(approved.reference + approved.approvalTokenHash)}`;
    const recipients = approved.recipients?.map((r) => ({
      address: r.address,
      amount: r.amount,
      externalRef: `0xsim${simpleHash(approved.reference + r.address)}`,
    }));
    return { railId: this.railId, externalRef: txHash, status: "confirmed", ...(recipients ? { recipients } : {}) };
  }

  async status(ref: string): Promise<ProviderSettlementStatus> {
    return { status: "confirmed", externalRef: ref };
  }

  async refund(ref: string, _amount: Money): Promise<RefundResult> {
    return { externalRef: `refund:${ref}`, status: "failed" };
  }
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
