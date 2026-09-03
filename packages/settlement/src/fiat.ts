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

  /**
   * One PaymentIntent per call — for a milestone-based plan, the caller passes
   * a per-milestone `plan` view (its own `id`, `total_amount` = that
   * milestone's amount; see `capabilities().supportsMilestones: false` below)
   * so each milestone gets its own intent. A PaymentIntent can only be
   * captured ONCE (§ST-12/ST-13 follow-up), so one shared plan-level intent
   * cannot serve more than one milestone. `plan.id` doubles as the idempotency
   * key: a retried prepare() for the same milestone must not create a second
   * intent.
   */
  async prepare(plan: SettlementPlan): Promise<PreparedSettlement> {
    if (this.simulated) {
      return { railId: this.railId, reference: `sim_pi_${plan.id}` };
    }
    const intent = await this.client!.paymentIntents.create(
      {
        amount: plan.total_amount.amount,
        currency: plan.total_amount.currency.toLowerCase(),
        capture_method: "manual",
        // Card only, no redirect-based methods (§capabilities: assets ["USD"])
        // — this is a server-side manual-capture flow with no return_url/
        // customer-facing redirect page for automatic_payment_methods to send
        // them to.
        payment_method_types: ["card"],
        metadata: { settlement_plan_id: plan.id },
      },
      { idempotencyKey: `prepare:${plan.id}` },
    );
    return { railId: this.railId, reference: intent.id };
  }

  async execute(approved: ApprovedSettlement): Promise<ExecutionResult> {
    if (this.simulated) {
      const recipients = approved.recipients?.map((r) => ({
        address: r.address,
        amount: r.amount,
        externalRef: `sim_transfer_${approved.reference}_${r.address}`,
      }));
      return { railId: this.railId, externalRef: `sim_capture_${approved.reference}`, status: "confirmed", ...(recipients ? { recipients } : {}) };
    }
    // approvalTokenHash is a deterministic hash of the exact milestone + amount
    // (§13.5) — reused as the idempotency key so a retried execute() (Temporal
    // retries activities up to 3x) cannot double-capture or double-transfer.
    const captured = await this.client!.paymentIntents.capture(approved.reference, {}, { idempotencyKey: approved.approvalTokenHash });
    const status: ExecutionResult["status"] = captured.status === "succeeded" ? "confirmed" : "pending";

    // ST-12 — multi-party split: each recipient's `address` is a connected
    // account id; separate Transfers move funds out of the platform balance
    // after capture, grouped by reference (Stripe Connect destination model).
    let recipients: ExecutionResult["recipients"];
    if (status === "confirmed" && approved.recipients?.length) {
      recipients = await Promise.all(
        approved.recipients.map(async (r) => {
          const transfer = await this.client!.transfers.create(
            {
              amount: r.amount.amount,
              currency: r.amount.currency.toLowerCase(),
              destination: r.address,
              transfer_group: approved.reference,
            },
            { idempotencyKey: `${approved.approvalTokenHash}:${r.address}` },
          );
          return { address: r.address, amount: r.amount, externalRef: transfer.id };
        }),
      );
    }

    return { railId: this.railId, externalRef: captured.id, status, ...(recipients ? { recipients } : {}) };
  }

  async status(ref: string): Promise<ProviderSettlementStatus> {
    if (this.simulated) return { status: "confirmed", externalRef: ref };
    const intent = await this.client!.paymentIntents.retrieve(ref);
    return { status: intent.status === "succeeded" ? "confirmed" : "pending", externalRef: intent.id };
  }

  /**
   * A charge can only be refunded after it's been captured — an intent still
   * sitting in `requires_capture` (deadman auto-refund on a milestone that was
   * never released) has no charge to refund, only a hold to release via cancel.
   */
  async refund(ref: string, amount: Money): Promise<RefundResult> {
    if (this.simulated) return { externalRef: `sim_refund_${ref}`, status: "refunded" };
    const intent = await this.client!.paymentIntents.retrieve(ref);
    if (intent.status !== "succeeded") {
      const canceled = await this.client!.paymentIntents.cancel(ref, { idempotencyKey: `cancel:${ref}` });
      return { externalRef: canceled.id, status: canceled.status === "canceled" ? "refunded" : "pending" };
    }
    const refund = await this.client!.refunds.create(
      { payment_intent: ref, amount: amount.amount },
      { idempotencyKey: `refund:${ref}:${amount.amount}` },
    );
    return { externalRef: refund.id, status: refund.status === "succeeded" ? "refunded" : "pending" };
  }
}
