import { Injectable, UnauthorizedException } from "@nestjs/common";
import { enqueueEvent, getDb } from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import type { EventName } from "@opportunity-os/contracts";
import {
  payloadIdempotencyKey,
  timingSafeStringEqual,
  verifyHmacSignature,
} from "../common/webhook-signature";

type Payload = Record<string, unknown>;

/**
 * Inbound provider webhooks. Each verifies its signature/secret, then enqueues
 * a domain event on the transactional outbox for the owning worker to process
 * (§10). Verification is over the canonical JSON serialization of the parsed
 * body; production must verify against the raw request bytes (Stripe's exact
 * scheme) once a raw-body parser is wired into the Fastify adapter.
 */
@Injectable()
export class WebhooksService {
  async handleStripe(signature: string | undefined, body: Payload) {
    const secret = getConfig().settlement.stripeWebhookSecret;
    const raw = JSON.stringify(body);
    if (!secret || !signature || !verifyHmacSignature(secret, raw, signature)) {
      throw new UnauthorizedException("Invalid Stripe webhook signature");
    }
    const object = (body["data"] as Payload | undefined)?.["object"] as Payload | undefined;
    const reference = typeof object?.["id"] === "string" ? object["id"] : "stripe-event";
    await this.enqueue("settlement.released.v1", "transaction", reference, payloadIdempotencyKey("stripe", raw), {
      provider: "stripe",
      eventType: body["type"] ?? null,
      reference,
    });
    return { received: true };
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
