import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import Stripe from "stripe";
import {
  disputeMilestone,
  enqueueEvent,
  getDb,
  getMilestoneByProviderRef,
  getSettlementPlan,
  refundMilestone,
  releaseMilestone,
} from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import type { EventName, Money } from "@opportunity-os/contracts";
import {
  payloadIdempotencyKey,
  timingSafeStringEqual,
  verifyHmacSignature,
} from "../common/webhook-signature";

type Payload = Record<string, unknown>;

function milestoneAmountMinor(total: Money, amount: { kind: "amount" | "percentage"; value: number }): number {
  return amount.kind === "amount" ? Math.round(amount.value) : Math.round((total.amount * amount.value) / 100);
}

/** Which PaymentIntent id (our `settlement_milestones.provider_ref`) a Stripe event is about, if any. */
function paymentIntentRef(event: Stripe.Event): string | null {
  const object = event.data.object as { id?: string; payment_intent?: string | { id: string } | null };
  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
      return typeof object.id === "string" ? object.id : null;
    case "charge.refunded":
    case "charge.dispute.created":
      if (typeof object.payment_intent === "string") return object.payment_intent;
      if (object.payment_intent && typeof object.payment_intent === "object") return object.payment_intent.id;
      return null;
    default:
      return null;
  }
}

/**
 * Inbound provider webhooks. Each verifies its signature/secret, then enqueues
 * a domain event on the transactional outbox for the owning worker to process
 * (§10).
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger("WebhooksService");

  /**
   * §ST-13 async provider-status reconciliation. Verifies Stripe's real HMAC
   * scheme over the raw request bytes (`Stripe.webhooks.constructEvent` —
   * re-serializing the parsed body, as before, can differ byte-for-byte and
   * always fails verification; `req.rawBody` is populated by `main.ts`'s
   * `rawBody: true`). Then reconciles by the PaymentIntent id we stored as the
   * milestone's `provider_ref` (ST-12/real-provider follow-up) — release/refund
   * paths already execute synchronously and are idempotent (guarded DB
   * updates), so this closes the gap where that synchronous call reported
   * "pending" (some payment methods capture/refund asynchronously) or the
   * process died before persisting the result. An unexpected async failure
   * disputes the milestone (blocks money, reversible) rather than guessing.
   */
  async handleStripe(signature: string | undefined, rawBody: Buffer | undefined) {
    const secret = getConfig().settlement.stripeWebhookSecret;
    if (!secret || !signature || !rawBody) {
      throw new UnauthorizedException("Invalid Stripe webhook signature");
    }
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      throw new UnauthorizedException(`Invalid Stripe webhook signature: ${String(err)}`);
    }

    await this.enqueue(
      "settlement.released.v1",
      "settlement_milestone",
      paymentIntentRef(event) ?? event.id,
      payloadIdempotencyKey("stripe", event.id),
      { provider: "stripe", eventType: event.type, eventId: event.id },
    );
    try {
      await this.reconcileStripeEvent(event);
    } catch (err) {
      // A benign state conflict (e.g. the plan is already DISPUTED/FROZEN, or
      // this event arrived after we'd already reconciled via another path)
      // must not make Stripe retry forever — acknowledge receipt regardless.
      this.logger.warn(`could not reconcile Stripe event ${event.id} (${event.type}): ${String(err)}`);
    }
    return { received: true };
  }

  private async reconcileStripeEvent(event: Stripe.Event): Promise<void> {
    const ref = paymentIntentRef(event);
    if (!ref) return;
    const milestone = await getMilestoneByProviderRef(ref);
    if (!milestone) return; // Not ours, or not a milestone-scoped rail — nothing to reconcile.
    if (milestone.status === "released" || milestone.status === "refunded") return; // Already settled; idempotent no-op.

    const plan = await getSettlementPlan(milestone.settlement_plan_id);
    if (!plan) return;
    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);

    switch (event.type) {
      case "payment_intent.succeeded":
        // We normally record "released" synchronously at capture time; this
        // only does work if that write never landed (e.g. the process died
        // right after Stripe confirmed the capture).
        if (milestone.status === "verified") {
          await releaseMilestone({
            milestoneId: milestone.id,
            amountMinor,
            currency: total.currency,
            actorId: "stripe-webhook",
            externalTransactionRef: ref,
            reason: "stripe_webhook_reconciliation",
          });
        }
        return;
      case "charge.refunded":
        await refundMilestone({
          milestoneId: milestone.id,
          actorId: "stripe-webhook",
          externalRefundRef: ref,
          reason: "stripe_webhook_reconciliation",
        });
        return;
      case "payment_intent.payment_failed":
      case "charge.dispute.created":
        if (milestone.status !== "disputed") {
          await disputeMilestone({
            milestoneId: milestone.id,
            actorId: "stripe-webhook",
            reason: `Stripe reported ${event.type} on ${ref}`,
          });
        }
        return;
      default:
        return;
    }
  }

  async handleTelegram(secretToken: string | undefined, body: Payload) {
    const expected = getConfig().notifications.telegramBotToken;
    if (!expected || !secretToken || !timingSafeStringEqual(expected, secretToken)) {
      throw new UnauthorizedException("Invalid Telegram webhook secret token");
    }
    // Approval decisions arrive as callback_query.data: "approve:<id>" | "reject:<id>".
    const callback = body["callback_query"] as Payload | undefined;
    const data = typeof callback?.["data"] === "string" ? callback["data"] : "";
    const [action, approvalId] = data.split(":");
    if ((action === "approve" || action === "reject") && approvalId) {
      const event: EventName = action === "approve" ? "approval.approved.v1" : "approval.rejected.v1";
      await this.enqueue(event, "approval", approvalId, payloadIdempotencyKey("telegram", JSON.stringify(body)), {
        provider: "telegram",
        approvalId,
        decision: action,
      });
    }
    // Non-decision updates are acknowledged and ignored (idempotent no-op).
    return { received: true };
  }

  async handleChain(network: string, signature: string | undefined, body: Payload) {
    const secret = getConfig().security.approvalTokenSecret;
    const raw = JSON.stringify(body);
    if (!signature || !verifyHmacSignature(secret, raw, signature)) {
      throw new UnauthorizedException("Invalid chain webhook signature");
    }
    const reference =
      typeof body["reference"] === "string"
        ? body["reference"]
        : typeof body["txHash"] === "string"
          ? (body["txHash"] as string)
          : `chain-${network}`;
    await this.enqueue(
      "settlement.released.v1",
      "settlement_plan",
      reference,
      payloadIdempotencyKey(`chain:${network}`, raw),
      { provider: "chain", network, reference },
    );
    return { received: true };
  }

  private async enqueue(
    eventName: EventName,
    aggregateType: string,
    aggregateId: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ) {
    await enqueueEvent(getDb(), { eventName, aggregateType, aggregateId, idempotencyKey, payload });
  }
}
