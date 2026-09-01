import Stripe from "stripe";
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
 * §19.1 Fiat rail on Stripe test mode. When no secret key is configured the
 * rail runs in a deterministic SIMULATED mode so dev/CI golden-path tests
 * (§26) execute without network or credentials. NOTE: platform-held funds are
 * NOT marketed as legal "escrow" (§19.1, §29).
 */
export class StripeFiatRail implements SettlementRail {
  readonly railId = "stripe";
  readonly family = "fiat" as const;
  private readonly client?: Stripe;

  constructor(secretKey?: string) {
    if (secretKey) this.client = new Stripe(secretKey, { apiVersion: "2024-06-20" as Stripe.LatestApiVersion });
  }

  private get simulated(): boolean {
    return this.client === undefined;
  }

  capabilities(): RailCapabilities {
    return {
      family: "fiat",
      supportsMilestones: false,
      supportsMultiRecipient: true,
      supportsRefund: true,
      supportsDispute: true,
      assets: ["USD"],
    };
  }

  async quote(plan: SettlementPlan): Promise<SettlementQuote> {
    // Stripe standard pricing approximation: 2.9% + $0.30.
    const fee = Math.round(plan.total_amount.amount * 0.029) + 30;
    return { railId: this.railId, fee: { amount: fee, currency: plan.total_amount.currency }, etaSeconds: 2, asset: plan.asset };
  }

  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    if (this.simulated) {
      return { railId: this.railId, reference: `sim_pi_${plan.id}` };
    }
    const intent = await this.client!.paymentIntents.create({
      amount: plan.total_amount.amount,
      currency: plan.total_amount.currency.toLowerCase(),
      capture_method: "manual",
      metadata: { settlement_plan_id: plan.id },
    });
    return { railId: this.railId, reference: intent.id };
  }

  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    if (this.simulated) {
      return { railId: this.railId, externalRef: `sim_capture_${approved.reference}`, status: "confirmed" };
    }
    const captured = await this.client!.paymentIntents.capture(approved.reference);
    return {
      railId: this.railId,
      externalRef: captured.id,
      status: captured.status === "succeeded" ? "confirmed" : "pending",
    };
  }

  async status(ref: string): Promise<ProviderSettlementStatus> {
    if (this.simulated) return { status: "confirmed", externalRef: ref };
    const intent = await this.client!.paymentIntents.retrieve(ref);
    return { status: intent.status === "succeeded" ? "confirmed" : "pending", externalRef: intent.id };
  }

  async refund(ref: string, amount: Money): Promise<RefundResult> {
    if (this.simulated) return { externalRef: `sim_refund_${ref}`, status: "refunded" };
    const refund = await this.client!.refunds.create({ payment_intent: ref, amount: amount.amount });
    return { externalRef: refund.id, status: refund.status === "succeeded" ? "refunded" : "pending" };
  }
}
