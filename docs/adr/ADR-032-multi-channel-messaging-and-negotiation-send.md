# ADR-032: Multi-channel messaging intake + negotiation:send execution

- Status: Accepted
- Date: 2026-09-05

## Context

Two Telegram/Twilio inbound-messaging prototypes already existed
(`POST /webhooks/telegram`, `POST /webhooks/twilio-sms`): each verified its
provider's signature, mapped a plain text message into a `SignalSubmitBody`,
called `SignalsService.submit` directly, and replied with a fixed
acknowledgment string via a private, provider-specific sender duplicated in
`WebhooksService`. Separately, `negotiation:send` had existed since ADR-020
as a declared `Permission` requiring an approval token in `authorize()`'s
attribute layer — but it was never granted to any role in
`ROLE_PERMISSIONS`, and no endpoint or service method ever called it.
`draftNegotiation`/`templateDraft` produced message text; nothing sent it.

## Decision

- **Two more inbound channels**, same shape as the existing two: email via
  Mailgun inbound routes (`POST /webhooks/email`, `verifyMailgunSignature` —
  HMAC-SHA256 over `timestamp + token`, a third distinct signing scheme
  alongside Twilio's URL-inclusive HMAC and Circle's asymmetric ECDSA) and
  WhatsApp Business Cloud API (`GET`/`POST /webhooks/whatsapp` — Meta's
  verify-token handshake plus `X-Hub-Signature-256`, which reuses the
  existing payload-only `verifyHmacSignature` rather than a new function).
  `SignalChannel` gains `email`/`whatsapp` alongside the existing
  `telegram`/`sms`.
- **Outbound dispatch extracted into `apps/api/src/messaging`**: a
  `MessageChannel` interface (`send(identity, text): Promise<string |
  undefined>`, the return being the provider's message id when it gives one)
  with `TelegramChannel`/`TwilioSmsChannel`/`EmailChannel`/`WhatsAppChannel`
  implementations and a `MessageChannelRegistry`, composed in
  `messaging.module.ts` the same way `settlement/rails.ts` composes
  `SettlementService`. `WebhooksService`'s four inbound handlers now share
  one `intakeAndAck` helper instead of each having its own submit+reply
  logic. Every channel is a no-op (`undefined`) when unconfigured — the same
  keyless-dev convention as the settlement rails, not a new one.
- **`negotiation:send` actually wired**: granted to `operator`/`admin` in
  `packages/auth` (a real gap-fill — the permission existed but authorized
  no one). New `hashNegotiationSendTerms` (`packages/audit`) binds an
  approval to this exact `{negotiationId, channel, identity, text}` — an
  approval authorizes *this wording to this destination*, not open-ended
  negotiation authority. New `NEGOTIATION_TRANSITIONS` (`packages/domain`):
  `draft`/`countered` → `proposed` for our own outbound send;
  `proposed`/`countered` → `accepted`/`rejected`/`expired` are left modeled
  but unreachable until something processes the counterparty's reply (see
  Consequences). `POST /negotiations/:id/send`
  (`apps/api/src/negotiations/`) mirrors `TransactionService.propose`
  exactly: verify token against the hash, re-check the approval row is
  still approved and matches the target entity, *then* dispatch via
  `MessageChannelRegistry`, then persist (`sendNegotiation` — assert
  transition, append the returned message id to
  `negotiations.outbound_message_ids`, hash-chained audit event, emit the
  already-allocated `negotiation.send_requested.v1`). Dispatch happens
  before the DB write (not after) so a failed send never gets recorded as
  sent; the state-machine check happens twice — once in the service before
  dispatch (fail fast, don't send a message that can't be recorded) and
  again inside the repo's transaction (race safety) — deliberately
  redundant, cheap enough not to matter.

## Consequences

A human can now approve one exact outbound negotiation message and have it
actually delivered to a real channel+identity, audited and state-tracked —
the gap identified in the prior session's messaging-backlog discussion is
closed for the *outbound* half. Still open, unchanged from that discussion:
no `Counterparty`-backed identity resolution (the send endpoint takes
channel+identity as explicit input, same simplification the inbound
prototypes made); inbound replies don't thread to an open negotiation (an
inbound message always creates a fresh signal, never advances
`NEGOTIATION_TRANSITIONS`'s `proposed`/`countered` edges — so today's
"2-way channel" is inbound-open/outbound-gated-per-message, not a live
back-and-forth the system tracks); Mailgun inbound routes post
`multipart/form-data`, and `main.ts` only registers an
`application/x-www-form-urlencoded` parser (Twilio's content type) — a real
deployment needs `@fastify/multipart` too; none of the four outbound
channels has been exercised against a live provider account (same
"unverified against a live account" caveat every provider integration in
this codebase has shipped with before its live-verification pass).
