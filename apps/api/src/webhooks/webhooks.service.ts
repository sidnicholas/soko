import { createPublicKey, verify as verifyEcdsa } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import Stripe from "stripe";
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  disputeMilestone,
  enqueueEvent,
  getDb,
  getMilestoneByExternalTransactionRef,
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
  verifyMailgunSignature,
  verifyTwilioSignature,
} from "../common/webhook-signature";
import { SignalsService } from "../signals/signals.service";
import { SignalSubmitSchema, type SignalSubmitBody } from "../signals/signal.dto";
import { MessageChannelRegistry } from "../messaging/channels";

type Payload = Record<string, unknown>;

/**
 * §11 messaging backlog, prototype slice — map a Telegram `message` update
 * into a `/signals`-shaped supply signal. Pure so it's unit-testable without
 * the NestJS DI graph; identity is carried as `source_id`/`raw` rather than a
 * resolved `Counterparty` (no counterparty-by-channel-identity lookup exists
 * yet — see project memory §11). Always `kind: "supply"`: the prototype's
 * explicit scope ("send things they want to sell") — routing to demand vs.
 * supply by content is a real follow-up, not this pass.
 */
export function telegramMessageToSignal(message: Payload): SignalSubmitBody | undefined {
  const text = typeof message["text"] === "string" ? message["text"].trim() : "";
  const chat = message["chat"] as Payload | undefined;
  const chatId = chat?.["id"];
  const from = message["from"] as Payload | undefined;
  if (text.length === 0 || (typeof chatId !== "number" && typeof chatId !== "string")) return undefined;
  return SignalSubmitSchema.parse({
    channel: "telegram",
    kind: "supply",
    source_id: `telegram:${chatId}`,
    description: text,
    source_reliability: 0.4, // Unauthenticated stranger, no track record yet — same caution as other unattested channels.
    raw: { chatId, fromId: from?.["id"] ?? null, messageId: message["message_id"] ?? null },
  });
}

/**
 * §11 messaging backlog — same shape as `telegramMessageToSignal`, for an
 * inbound Twilio SMS webhook body (already parsed from
 * application/x-www-form-urlencoded into a flat string map by `main.ts`'s
 * content-type parser).
 */
export function twilioSmsToSignal(body: Record<string, string>): SignalSubmitBody | undefined {
  const text = (body["Body"] ?? "").trim();
  const from = body["From"];
  if (text.length === 0 || !from) return undefined;
  return SignalSubmitSchema.parse({
    channel: "sms",
    kind: "supply",
    source_id: `sms:${from}`,
    description: text,
    source_reliability: 0.4, // Same caution as the Telegram prototype — unauthenticated, no track record.
    raw: { from, to: body["To"] ?? null, messageSid: body["MessageSid"] ?? null },
  });
}

/**
 * §11 messaging backlog — Mailgun inbound-route webhook body, same shape as
 * `telegramMessageToSignal`. Mailgun's documented field names for a "store
 * and forward"/"forward" route: `sender`, `recipient`, `subject`,
 * `body-plain`. **Not yet exercised against a live Mailgun route** — routes
 * post `multipart/form-data`, and `main.ts` only registers a parser for
 * `application/x-www-form-urlencoded` (Twilio's content type); a real
 * deployment needs `@fastify/multipart` wired up too (see project memory
 * §11). This function itself is content-type-agnostic — it just reads a flat
 * string map, whatever parsed it.
 */
export function mailgunInboundToSignal(body: Record<string, string>): SignalSubmitBody | undefined {
  const text = (body["body-plain"] ?? body["stripped-text"] ?? "").trim();
  const sender = body["sender"] ?? body["from"];
  if (text.length === 0 || !sender) return undefined;
  return SignalSubmitSchema.parse({
    channel: "email",
    kind: "supply",
    source_id: `email:${sender}`,
    description: text,
    source_reliability: 0.4, // Same caution as Telegram/SMS — unauthenticated, no track record.
    raw: { from: sender, subject: body["subject"] ?? null, messageId: body["Message-Id"] ?? null },
  });
}

/**
 * §11 messaging backlog — WhatsApp Business Cloud API webhook body
 * (Meta's nested `entry[].changes[].value.messages[]` shape). Reads only
 * the first message of the first change/entry — a real deployment would
 * loop all of them; this prototype mirrors the single-message assumption
 * the other three channels make (one inbound event, one signal).
 */
export function whatsappMessageToSignal(body: Payload): SignalSubmitBody | undefined {
  const entry = (body["entry"] as Payload[] | undefined)?.[0];
  const change = (entry?.["changes"] as Payload[] | undefined)?.[0];
  const value = change?.["value"] as Payload | undefined;
  const message = (value?.["messages"] as Payload[] | undefined)?.[0];
  const from = message?.["from"];
  const text = ((message?.["text"] as Payload | undefined)?.["body"] as string | undefined)?.trim() ?? "";
  if (text.length === 0 || typeof from !== "string") return undefined;
  return SignalSubmitSchema.parse({
    channel: "whatsapp",
    kind: "supply",
    source_id: `whatsapp:${from}`,
    description: text,
    source_reliability: 0.4,
    raw: { from, messageId: message?.["id"] ?? null },
  });
}

let circleClient: CircleDeveloperControlledWalletsClient | undefined;

/** Lazily built — read-only calls (getNotificationSignature) don't need the entity secret's signing ceremony, but the client requires one to construct. */
function circle(): CircleDeveloperControlledWalletsClient | undefined {
  const cfg = getConfig().settlement;
  if (!cfg.circleApiKey || !cfg.circleEntitySecret) return undefined;
  if (!circleClient) {
    circleClient = initiateDeveloperControlledWalletsClient({ apiKey: cfg.circleApiKey, entitySecret: cfg.circleEntitySecret });
  }
  return circleClient;
}

const circlePublicKeyCache = new Map<string, string>();

/** Circle signs notifications asymmetrically; the key id names which of Circle's public keys to fetch and cache (§ST-13). */
async function circlePublicKeyPem(keyId: string): Promise<string> {
  const cached = circlePublicKeyCache.get(keyId);
  if (cached) return cached;
  const client = circle();
  if (!client) throw new Error("Circle is not configured");
  const result = await client.getNotificationSignature(keyId);
  const pem = result.data?.publicKey;
  if (!pem) throw new Error(`Circle returned no public key for key id ${keyId}`);
  circlePublicKeyCache.set(keyId, pem);
  return pem;
}

/**
 * Pure crypto, no Circle account needed — exported so it's directly
 * exercisable (e.g. `scripts/verify-circle-provider.ts`) with a locally
 * generated EC keypair, the same way Stripe's `constructEvent` was checked
 * with `generateTestHeaderString` rather than only through a live account.
 * DER encoding is Node's default for `verify()` with an EC key, and the
 * common convention for KMS/HSM-backed ECDSA signing (which is how Circle
 * signs) — unverified against a live Circle account in this pass; double-
 * check against a real notification once one is flowing.
 */
export function verifyCircleSignature(rawBody: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  return verifyEcdsa("sha256", rawBody, createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64"));
}

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

  constructor(
    @Inject(SignalsService) private readonly signals: SignalsService,
    @Inject(MessageChannelRegistry) private readonly channels: MessageChannelRegistry,
  ) {}

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

  /**
   * §ST-13 async provider-status reconciliation for the stablecoin rail
   * (Circle Developer-Controlled Wallets). Circle transfers are asynchronous
   * by nature — `execute()` always returns "pending" and records the
   * transaction id via `markMilestoneReleasePending`'s `external_transaction_ref`
   * (not `provider_ref`, which holds the shared wallet id here, not a
   * per-transaction reference) — so this webhook is not just a fallback the
   * way Stripe's mostly is, it's the *primary* way a Circle release ever
   * finalizes. Verifies Circle's real ECDSA_SHA_256 signature (asymmetric,
   * unlike Stripe/Telegram's shared-secret HMAC): fetch + cache the signing
   * public key by the `X-Circle-Key-Id` header, verify over the raw body.
   *
   * Known gap: a multi-recipient (ST-12) release submits one Circle
   * transaction per recipient but only the first's id is tracked on the
   * milestone, so only that one reconciles here — same documented limitation
   * as Stripe's un-reconciled Transfer events.
   */
  async handleCircle(signature: string | undefined, keyId: string | undefined, rawBody: Buffer | undefined) {
    if (!getConfig().settlement.circleApiKey || !signature || !keyId || !rawBody) {
      throw new UnauthorizedException("Invalid Circle webhook signature");
    }
    let publicKeyPem: string;
    try {
      publicKeyPem = await circlePublicKeyPem(keyId);
    } catch (err) {
      throw new UnauthorizedException(`Could not retrieve Circle's notification public key: ${String(err)}`);
    }
    let ok: boolean;
    try {
      ok = verifyCircleSignature(rawBody, signature, publicKeyPem);
    } catch (err) {
      throw new UnauthorizedException(`Invalid Circle webhook signature: ${String(err)}`);
    }
    if (!ok) throw new UnauthorizedException("Invalid Circle webhook signature");

    let body: Payload;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as Payload;
    } catch {
      throw new UnauthorizedException("Circle webhook body is not valid JSON");
    }
    const notification = (body["notification"] as Payload | undefined) ?? body;
    const transactionId = typeof notification["id"] === "string" ? notification["id"] : undefined;
    const state = typeof notification["state"] === "string" ? notification["state"] : undefined;

    await this.enqueue(
      "settlement.released.v1",
      "settlement_milestone",
      transactionId ?? "circle-event",
      payloadIdempotencyKey("circle", rawBody.toString("utf8")),
      { provider: "circle", state: state ?? null, transactionId: transactionId ?? null },
    );
    if (transactionId && state) {
      try {
        await this.reconcileCircleTransaction(transactionId, state);
      } catch (err) {
        this.logger.warn(`could not reconcile Circle transaction ${transactionId} (${state}): ${String(err)}`);
      }
    }
    return { received: true };
  }

  private async reconcileCircleTransaction(transactionId: string, state: string): Promise<void> {
    const milestone = await getMilestoneByExternalTransactionRef(transactionId);
    if (!milestone) return; // Not ours, or a recipient-level transfer we don't track (see doc comment above).
    if (milestone.status === "released" || milestone.status === "refunded") return; // Already settled; idempotent no-op.

    const plan = await getSettlementPlan(milestone.settlement_plan_id);
    if (!plan) return;
    const total = plan.total_amount as Money;
    const amount = milestone.amount_or_percentage as { kind: "amount" | "percentage"; value: number };
    const amountMinor = milestoneAmountMinor(total, amount);

    if (state === "COMPLETE") {
      if (milestone.status === "verified") {
        await releaseMilestone({
          milestoneId: milestone.id,
          amountMinor,
          currency: total.currency,
          actorId: "circle-webhook",
          externalTransactionRef: transactionId,
          reason: "circle_webhook_reconciliation",
        });
      }
      return;
    }
    if (state === "FAILED" || state === "DENIED" || state === "CANCELLED" || state === "STUCK") {
      if (milestone.status !== "disputed") {
        await disputeMilestone({ milestoneId: milestone.id, actorId: "circle-webhook", reason: `Circle reported ${state} on ${transactionId}` });
      }
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
      return { received: true };
    }

    // §11 messaging backlog, prototype slice — a plain text message is a
    // "here's what I want to sell" intake, not an approval decision. Feeds
    // the same risk-gated `/signals` pipeline everything else goes through
    // (SignalsService.submit already rejects instruction-like content —
    // exactly the untrusted-inbound-text case an open channel adds).
    const message = body["message"] as Payload | undefined;
    if (message) {
      const signal = telegramMessageToSignal(message);
      if (!signal) return { received: true }; // No text (a sticker, a photo, ...) — nothing to intake yet.
      const chatId = signal.raw?.["chatId"];
      await this.intakeAndAck(signal, "telegram", typeof chatId === "number" ? String(chatId) : (chatId as string));
    }
    // Everything else is acknowledged and ignored (idempotent no-op).
    return { received: true };
  }

  /**
   * §11 messaging backlog — second channel, same pattern as
   * `handleTelegram`: verify the provider's signature (Twilio signs the
   * exact webhook URL + sorted POST params, not the payload — see
   * `verifyTwilioSignature`), map to a `SignalSubmitBody`, submit through the
   * same risk-gated `SignalsService.submit`, reply in the same SMS thread.
   * `path` is the request path Nest saw (`req.url`, e.g.
   * "/v1/webhooks/twilio-sms"); prefixed with `PUBLIC_API_BASE_URL` to
   * reconstruct the absolute URL Twilio actually signed — this breaks if a
   * reverse proxy rewrites scheme/host/path before this app sees the request
   * (known fragility, see project memory §11).
   */
  async handleTwilioSms(signature: string | undefined, body: Record<string, string>, path: string) {
    const { twilioAccountSid, twilioAuthToken, publicApiBaseUrl } = getConfig().notifications;
    if (!twilioAccountSid || !twilioAuthToken || !publicApiBaseUrl || !signature) {
      throw new UnauthorizedException("Invalid Twilio webhook signature");
    }
    const url = `${publicApiBaseUrl.replace(/\/$/, "")}${path}`;
    if (!verifyTwilioSignature(url, body, signature, twilioAuthToken)) {
      throw new UnauthorizedException("Invalid Twilio webhook signature");
    }

    const signal = twilioSmsToSignal(body);
    if (!signal) return { received: true }; // No Body/From — nothing to intake.
    await this.intakeAndAck(signal, "sms", signal.raw?.["from"] as string);
    return { received: true };
  }

  /**
   * §11 messaging backlog — email channel. Verifies Mailgun's HMAC over
   * `timestamp + token` (not the body or a URL, unlike the other three
   * providers here — see `verifyMailgunSignature`). See
   * `mailgunInboundToSignal`'s doc comment for the multipart-parsing caveat.
   */
  async handleEmail(body: Record<string, string>) {
    const signingKey = getConfig().notifications.mailgunSigningKey;
    const { timestamp, token, signature } = body;
    if (!signingKey || !timestamp || !token || !signature || !verifyMailgunSignature(timestamp, token, signature, signingKey)) {
      throw new UnauthorizedException("Invalid Mailgun webhook signature");
    }
    const signal = mailgunInboundToSignal(body);
    if (!signal) return { received: true };
    await this.intakeAndAck(signal, "email", signal.raw?.["from"] as string);
    return { received: true };
  }

  /**
   * §11 messaging backlog — WhatsApp Business Cloud API (Meta) verification
   * handshake. Meta calls this once when the webhook URL is configured;
   * echo `hub.challenge` back verbatim only if `hub.verify_token` matches
   * what we configured (never shared with Meta in advance, unlike the other
   * providers' secrets — we choose it, Meta echoes it back to prove it's
   * really hitting our configured URL).
   */
  verifyWhatsAppSubscription(mode: string | undefined, verifyToken: string | undefined, challenge: string | undefined): string {
    const expected = getConfig().notifications.whatsappVerifyToken;
    if (mode !== "subscribe" || !expected || !verifyToken || !challenge || !timingSafeStringEqual(expected, verifyToken)) {
      throw new UnauthorizedException("Invalid WhatsApp webhook verification request");
    }
    return challenge;
  }

  /**
   * §11 messaging backlog — WhatsApp inbound messages. Meta signs the raw
   * JSON body with HMAC-SHA256 (`X-Hub-Signature-256: sha256=<hex>`), the
   * same payload-only scheme `verifyHmacSignature` already implements for
   * the chain webhook — reused rather than duplicated.
   */
  async handleWhatsApp(signature: string | undefined, rawBody: Buffer | undefined) {
    const appSecret = getConfig().notifications.whatsappAppSecret;
    if (!appSecret || !signature || !rawBody || !verifyHmacSignature(appSecret, rawBody.toString("utf8"), signature)) {
      throw new UnauthorizedException("Invalid WhatsApp webhook signature");
    }
    let body: Payload;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as Payload;
    } catch {
      throw new UnauthorizedException("WhatsApp webhook body is not valid JSON");
    }
    const signal = whatsappMessageToSignal(body);
    if (!signal) return { received: true }; // Not a text message (status update, image, ...) — nothing to intake yet.
    await this.intakeAndAck(signal, "whatsapp", signal.raw?.["from"] as string);
    return { received: true };
  }

  /**
   * Shared by all four inbound channels: submit the mapped signal through
   * the same risk-gated pipeline everything else goes through
   * (`SignalsService.submit` already rejects instruction-like content), then
   * acknowledge or apologize in the same channel/identity the message came
   * from. A dispatch failure (channel misconfigured, provider error) is
   * logged, not thrown — the inbound webhook still acknowledges receipt so
   * the provider doesn't retry a signal we already captured.
   */
  private async intakeAndAck(signal: SignalSubmitBody, channelId: string, identity: string): Promise<void> {
    try {
      await this.signals.submit(signal);
      await this.channels
        .send(channelId, identity, "Got it — logged as a listing on Soko. We'll follow up here.")
        .catch((err) => this.logger.warn(`${channelId} ack reply failed: ${String(err)}`));
    } catch (err) {
      if (err instanceof BadRequestException) {
        await this.channels.send(channelId, identity, "Sorry, couldn't process that message.").catch(() => undefined);
      } else {
        this.logger.warn(`${channelId} message intake failed: ${String(err)}`);
      }
    }
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
