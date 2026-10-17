import { sql, type Transaction } from "kysely";
import { consentInForce, newMessageId, normalizeChannel, outreachContentHash, suppressionHash, type InboundClass } from "@opportunity-os/relationship";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import type { Database } from "../schema";
import { appendAuditEvent } from "./audit";
import type { Actor, LinkSubject } from "./relationships";

/**
 * Email outreach (migration 0036, PRD v2 FR-07, ADR-045). An outbound
 * message is a draft until a person with outreach:send approves its exact
 * recipient, subject and body (content_hash); it is then queued, claimed
 * ('sending') and sent once. A message stuck in 'sending' is never retried
 * automatically: it shows as an exception. Consent, bounces and suppression
 * are checked at approval and again at send time. Replies are threaded by
 * Message-ID, else by the sender's address. Audit events and outbox events
 * carry ids and classifications only, never message content.
 */

export type OutboundStatus = "draft" | "queued" | "sending" | "sent" | "failed" | "cancelled";

export class OutreachError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "not_draft" | "stale" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

export interface ConversationRow {
  id: string;
  counterparty_id: string;
  party_name: string;
  their_address: string;
  subject: string;
  subject_type: string | null;
  subject_id: string | null;
  status: string;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: "outbound" | "inbound";
  status: string;
  subject: string;
  body_text: string;
  content_hash: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  to_address: string | null;
  classification: InboundClass | null;
  injection_flag: boolean;
  approved_by: string | null;
  approved_at: string | null;
  queued_at: string | null;
  sent_at: string | null;
  received_at: string | null;
  reviewed_at: string | null;
  error: string | null;
  created_at: string;
}

const CONVERSATION_COLUMNS = [
  "c.id",
  "c.counterparty_id",
  sql<string>`coalesce(p.display_name, p.normalized_name)`.as("party_name"),
  "c.their_address",
  "c.subject",
  "c.subject_type",
  "c.subject_id",
  "c.status",
  sql<string | null>`c.last_outbound_at::text`.as("last_outbound_at"),
  sql<string | null>`c.last_inbound_at::text`.as("last_inbound_at"),
  sql<string>`c.created_at::text`.as("created_at"),
] as const;

const MESSAGE_COLUMNS = [
  "m.id",
  "m.conversation_id",
  "m.direction",
  "m.status",
  "m.subject",
  "m.body_text",
  "m.content_hash",
  "m.rfc_message_id",
  "m.in_reply_to",
  "m.from_address",
  "m.to_address",
  "m.classification",
  "m.injection_flag",
  "m.approved_by",
  sql<string | null>`m.approved_at::text`.as("approved_at"),
  sql<string | null>`m.queued_at::text`.as("queued_at"),
  sql<string | null>`m.sent_at::text`.as("sent_at"),
  sql<string | null>`m.received_at::text`.as("received_at"),
  sql<string | null>`m.reviewed_at::text`.as("reviewed_at"),
  "m.error",
  sql<string>`m.created_at::text`.as("created_at"),
] as const;

const cast = <T>(r: unknown) => r as T;
const MAX_BODY = 20_000;

async function audit(tx: Transaction<Database>, actor: Actor, action: string, messageId: string, inputHash: string | null = null) {
  await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action, entityType: "conversation_message", entityId: messageId, inputHash });
}

async function touchParty(tx: Transaction<Database>, partyId: string) {
  await tx
    .updateTable("counterparties")
    .set({ last_activity_at: sql`now()`, updated_at: sql`now()`, status: "active", archived_at: null, freshness_due_at: null })
    .where("id", "=", partyId)
    .execute();
}

/**
 * Why this party may not be emailed at this address right now, or null.
 * Recorded consent is required (ADR-041); a bounced address, a suppressed
 * address or an opt-out blocks.
 */
async function blockReason(tx: Transaction<Database>, partyId: string, address: string): Promise<string | null> {
  const consents = await tx
    .selectFrom("contact_consents")
    .select(["channel_kind", "purpose", "status", "basis", sql<string>`recorded_at::text`.as("recorded_at"), sql<string | null>`expires_at::text`.as("expires_at")])
    .where("counterparty_id", "=", partyId)
    .execute();
  const consent = consentInForce(consents, "email", "outreach");
  if (!consent) return "no_consent_recorded";
  if (consent.status !== "granted") return `consent_${consent.status}`;
  const channel = await tx.selectFrom("contact_channels").select("status").where("counterparty_id", "=", partyId).where("kind", "=", "email").where("normalized_value", "=", address).executeTakeFirst();
  if (!channel) return "address_not_on_contact";
  if (channel.status !== "active") return `address_${channel.status}`;
  const suppressed = await tx.selectFrom("contact_suppressions").select("identifier_hash").where("identifier_hash", "=", suppressionHash("email", address)).executeTakeFirst();
  if (suppressed) return "address_suppressed";
  return null;
}

/** Why a party cannot be emailed at this address, for the compose form (null = allowed). */
export async function outreachBlockReason(partyId: string, address: string): Promise<string | null> {
  const normalized = normalizeChannel("email", address);
  if (!normalized) return "invalid_address";
  return getDb()
    .transaction()
    .execute((tx) => blockReason(tx, partyId, normalized));
}

export interface NewDraft {
  partyId: string;
  toAddress?: string;
  subject?: string;
  body: string;
  subjectType?: LinkSubject | null;
  subjectId?: string | null;
  /** Reply inside an existing conversation. */
  conversationId?: string | null;
}

/** A new draft, in a new conversation or as the next message of an existing one. */
export async function createDraft(input: NewDraft, actor: Actor): Promise<{ conversationId: string; messageId: string }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      let conv: { id: string; their_address: string; subject: string; counterparty_id: string } | undefined;
      let inReplyTo: string | null = null;
      if (input.conversationId) {
        conv = await tx.selectFrom("conversations").select(["id", "their_address", "subject", "counterparty_id"]).where("id", "=", input.conversationId).executeTakeFirst();
        if (!conv || conv.counterparty_id !== input.partyId) throw new OutreachError("not_found", "Conversation not found");
        const last = await tx
          .selectFrom("conversation_messages")
          .select("rfc_message_id")
          .where("conversation_id", "=", conv.id)
          .where("rfc_message_id", "is not", null)
          .where("status", "in", ["sent", "received"])
          .orderBy("created_at", "desc")
          .executeTakeFirst();
        inReplyTo = last?.rfc_message_id ?? null;
      } else {
        const address = normalizeChannel("email", input.toAddress ?? "");
        if (!address) throw new OutreachError("invalid", "A valid recipient email is required");
        const party = await tx.selectFrom("counterparties").select("id").where("id", "=", input.partyId).executeTakeFirst();
        if (!party) throw new OutreachError("not_found", "Contact not found");
        const channel = await tx.selectFrom("contact_channels").select("id").where("counterparty_id", "=", input.partyId).where("kind", "=", "email").where("normalized_value", "=", address).executeTakeFirst();
        if (!channel) throw new OutreachError("invalid", "Add this address to the contact first");
        const subject = input.subject?.trim().slice(0, 200);
        if (!subject) throw new OutreachError("invalid", "A subject is required");
        conv = await tx
          .insertInto("conversations")
          .values({
            counterparty_id: input.partyId,
            their_address: address,
            subject,
            subject_type: input.subjectType ?? null,
            subject_id: input.subjectId ?? null,
            created_by: actor.id,
            updated_at: sql<string>`now()`,
          })
          .returning(["id", "their_address", "subject", "counterparty_id"])
          .executeTakeFirstOrThrow();
      }
      const body = input.body.trim();
      if (!body) throw new OutreachError("invalid", "The message is empty");
      const subject = input.conversationId ? (input.subject?.trim().slice(0, 200) || (/^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`)) : conv.subject;
      const msg = await tx
        .insertInto("conversation_messages")
        .values({
          conversation_id: conv.id,
          direction: "outbound",
          status: "draft",
          subject,
          body_text: body.slice(0, MAX_BODY),
          in_reply_to: inReplyTo,
          to_address: conv.their_address,
          created_by: actor.id,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await tx.updateTable("conversations").set({ updated_at: sql`now()`, status: "open" }).where("id", "=", conv.id).execute();
      await touchParty(tx, conv.counterparty_id);
      await audit(tx, actor, "outreach.drafted", msg.id);
      return { conversationId: conv.id, messageId: msg.id };
    });
}

async function lockOutbound(tx: Transaction<Database>, messageId: string) {
  const m = await tx
    .selectFrom("conversation_messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .select(["m.id", "m.status", "m.direction", "m.subject", "m.body_text", "m.to_address", "c.counterparty_id", "c.id as conversation_id"])
    .where("m.id", "=", messageId)
    .forUpdate()
    .executeTakeFirst();
  if (!m || m.direction !== "outbound") throw new OutreachError("not_found", "Message not found");
  return m;
}

export async function updateDraft(messageId: string, patch: { subject?: string; body?: string }, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await lockOutbound(tx, messageId);
      if (m.status !== "draft") throw new OutreachError("not_draft", "Only a draft can be edited");
      const subject = patch.subject?.trim().slice(0, 200);
      const body = patch.body?.trim().slice(0, MAX_BODY);
      if (patch.subject !== undefined && !subject) throw new OutreachError("invalid", "A subject is required");
      if (patch.body !== undefined && !body) throw new OutreachError("invalid", "The message is empty");
      await tx
        .updateTable("conversation_messages")
        .set({ ...(subject ? { subject } : {}), ...(body ? { body_text: body } : {}) })
        .where("id", "=", messageId)
        .execute();
      await audit(tx, actor, "outreach.edited", messageId);
    });
}

/** Cancels a draft or a queued message (nothing already being sent). */
export async function cancelMessage(messageId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await lockOutbound(tx, messageId);
      if (m.status !== "draft" && m.status !== "queued") throw new OutreachError("not_draft", `A ${m.status} message cannot be cancelled`);
      await tx.updateTable("conversation_messages").set({ status: "cancelled" }).where("id", "=", messageId).execute();
      await audit(tx, actor, "outreach.cancelled", messageId);
    });
}

/**
 * Approves a draft for sending. `expectedHash` is the content hash of what the
 * approver was shown; if the draft changed since, nothing is approved. The
 * contact must be emailable now (consent, address, suppression).
 */
export async function approveMessage(messageId: string, expectedHash: string, actor: Actor): Promise<{ contentHash: string }> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await lockOutbound(tx, messageId);
      if (m.status !== "draft") throw new OutreachError("not_draft", `This message is already ${m.status}`);
      const contentHash = outreachContentHash({ to: m.to_address ?? "", subject: m.subject, body: m.body_text });
      if (contentHash !== expectedHash) throw new OutreachError("stale", "The draft changed since you opened it; review it again");
      const blocked = await blockReason(tx, m.counterparty_id, m.to_address ?? "");
      if (blocked) throw new OutreachError("blocked", `Cannot email this contact: ${blocked}`);
      await tx
        .updateTable("conversation_messages")
        .set({ status: "queued", content_hash: contentHash, approved_by: actor.id, approved_at: sql`now()`, queued_at: sql`now()` })
        .where("id", "=", messageId)
        .execute();
      await audit(tx, actor, "outreach.approved", messageId, contentHash);
      await enqueueEvent(tx, {
        eventName: "outreach.scheduled.v1",
        aggregateType: "conversation",
        aggregateId: m.conversation_id,
        idempotencyKey: `outreach.scheduled:${messageId}`,
        payload: { conversationId: m.conversation_id, messageId, counterpartyId: m.counterparty_id, channel: "email" },
      });
      return { contentHash };
    });
}

export interface ClaimedMessage {
  id: string;
  conversationId: string;
  counterpartyId: string;
  to: string;
  subject: string;
  body: string;
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Claims the next queued message that may go out now: under the daily cap
 * (rolling 24 hours), still emailable, approved content unchanged, and the
 * contact not emailed within `minGapHours` without replying since. A
 * message that has become blocked fails with the reason (an exception for
 * the operator). The claim ('sending') is what prevents a double send.
 */
export async function claimNextOutbound(opts: { fromAddress: string; dailyCap: number; minGapHours: number; now?: Date }): Promise<ClaimedMessage | null> {
  const now = (opts.now ?? new Date()).toISOString();
  return getDb()
    .transaction()
    .execute(async (tx) => {
      // Serialize claimers so the cap holds with two senders (API and worker).
      await sql`select pg_advisory_xact_lock(4545)`.execute(tx);
      const sent = await tx
        .selectFrom("conversation_messages")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("direction", "=", "outbound")
        .where("status", "in", ["sending", "sent"])
        .where(sql<boolean>`coalesce(sent_at, queued_at) > ${now}::timestamptz - interval '24 hours'`)
        .executeTakeFirstOrThrow();
      if (sent.n >= opts.dailyCap) return null;
      const queued = await tx
        .selectFrom("conversation_messages as m")
        .innerJoin("conversations as c", "c.id", "m.conversation_id")
        .select(["m.id", "m.conversation_id", "c.counterparty_id", "m.to_address", "m.subject", "m.body_text", "m.content_hash", "m.in_reply_to"])
        .where("m.status", "=", "queued")
        .orderBy("m.queued_at")
        .limit(25)
        .forUpdate()
        .execute();
      for (const q of queued) {
        const fail = async (reason: string) => {
          await tx.updateTable("conversation_messages").set({ status: "failed", error: reason }).where("id", "=", q.id).execute();
          await audit(tx, { type: "system", id: null }, "outreach.blocked", q.id);
        };
        if (outreachContentHash({ to: q.to_address ?? "", subject: q.subject, body: q.body_text }) !== q.content_hash) {
          await fail("content_changed_after_approval");
          continue;
        }
        const blocked = await blockReason(tx, q.counterparty_id, q.to_address ?? "");
        if (blocked) {
          await fail(blocked);
          continue;
        }
        const lastOut = await tx
          .selectFrom("conversation_messages as m")
          .innerJoin("conversations as c", "c.id", "m.conversation_id")
          .select(sql<string>`max(m.sent_at)::text`.as("at"))
          .where("c.counterparty_id", "=", q.counterparty_id)
          .where("m.direction", "=", "outbound")
          .where("m.status", "in", ["sending", "sent"])
          .executeTakeFirst();
        if (lastOut?.at && Date.parse(lastOut.at) > Date.parse(now) - opts.minGapHours * 3_600_000) {
          const replied = await tx
            .selectFrom("conversation_messages as m")
            .innerJoin("conversations as c", "c.id", "m.conversation_id")
            .select("m.id")
            .where("c.counterparty_id", "=", q.counterparty_id)
            .where("m.direction", "=", "inbound")
            .where("m.classification", "=", "reply")
            .where(sql<boolean>`m.created_at > ${lastOut.at}::timestamptz`)
            .executeTakeFirst();
          if (!replied) continue;
        }
        const refs = await tx
          .selectFrom("conversation_messages")
          .select("rfc_message_id")
          .where("conversation_id", "=", q.conversation_id)
          .where("rfc_message_id", "is not", null)
          .where("status", "in", ["sent", "received"])
          .orderBy("created_at")
          .execute();
        const rfcMessageId = newMessageId(opts.fromAddress);
        await tx.updateTable("conversation_messages").set({ status: "sending", rfc_message_id: rfcMessageId, from_address: opts.fromAddress, sent_at: now }).where("id", "=", q.id).execute();
        return {
          id: q.id,
          conversationId: q.conversation_id,
          counterpartyId: q.counterparty_id,
          to: q.to_address ?? "",
          subject: q.subject,
          body: q.body_text,
          rfcMessageId,
          inReplyTo: q.in_reply_to,
          references: refs.map((r) => r.rfc_message_id!).slice(-10),
        };
      }
      return null;
    });
}

export async function markOutboundSent(messageId: string): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await lockOutbound(tx, messageId);
      if (m.status !== "sending") return;
      await tx.updateTable("conversation_messages").set({ status: "sent", sent_at: sql`now()`, error: null }).where("id", "=", messageId).execute();
      await tx.updateTable("conversations").set({ last_outbound_at: sql`now()`, updated_at: sql`now()` }).where("id", "=", m.conversation_id).execute();
      await touchParty(tx, m.counterparty_id);
      await audit(tx, { type: "system", id: null }, "outreach.sent", messageId);
      await enqueueEvent(tx, {
        eventName: "outreach.sent.v1",
        aggregateType: "conversation",
        aggregateId: m.conversation_id,
        idempotencyKey: `outreach.sent:${messageId}`,
        payload: { conversationId: m.conversation_id, messageId, counterpartyId: m.counterparty_id, channel: "email" },
      });
    });
}

/** The mail server refused the message: it was not sent. */
export async function markOutboundFailed(messageId: string, error: string): Promise<void> {
  await getDb()
    .updateTable("conversation_messages")
    .set({ status: "failed", error: error.slice(0, 500), sent_at: null })
    .where("id", "=", messageId)
    .where("status", "=", "sending")
    .execute();
}

/** Opt-out recorded for this party's email, and everything still queued to them cancelled. */
async function optOut(tx: Transaction<Database>, partyId: string, evidence: string) {
  await tx.insertInto("contact_consents").values({ counterparty_id: partyId, channel_kind: "email", purpose: "outreach", status: "opted_out", basis: "none", evidence }).execute();
  await cancelQueuedFor(tx, partyId, null, "opted_out");
  await enqueueEvent(tx, {
    eventName: "relationship.memory_updated.v1",
    aggregateType: "counterparty",
    aggregateId: partyId,
    idempotencyKey: `relationship.memory_updated:${partyId}:consent:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    payload: { counterpartyId: partyId, change: "consent", channelKind: "email", purpose: "outreach", status: "opted_out" },
  });
  await appendAuditEvent(tx, { actorType: "system", actorId: null, action: "relationship.consent", entityType: "counterparty", entityId: partyId });
}

async function cancelQueuedFor(tx: Transaction<Database>, partyId: string, address: string | null, reason: string) {
  let q = tx
    .updateTable("conversation_messages")
    .set({ status: "cancelled", error: reason })
    .where("status", "in", ["draft", "queued"])
    .where("direction", "=", "outbound")
    .where("conversation_id", "in", tx.selectFrom("conversations").select("id").where("counterparty_id", "=", partyId));
  if (address) q = q.where("to_address", "=", address);
  await q.execute();
}

/** The unsubscribe link or one-click header: opts the recipient of that message out. Idempotent. */
export async function unsubscribeByMessageId(rfcMessageId: string): Promise<boolean> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await tx
        .selectFrom("conversation_messages as m")
        .innerJoin("conversations as c", "c.id", "m.conversation_id")
        .select(["c.counterparty_id"])
        .where("m.rfc_message_id", "=", rfcMessageId)
        .where("m.direction", "=", "outbound")
        .executeTakeFirst();
      if (!m) return false;
      const consents = await tx
        .selectFrom("contact_consents")
        .select(["channel_kind", "purpose", "status", "basis", sql<string>`recorded_at::text`.as("recorded_at"), sql<string | null>`expires_at::text`.as("expires_at")])
        .where("counterparty_id", "=", m.counterparty_id)
        .execute();
      if (consentInForce(consents, "email", "outreach")?.status !== "opted_out") {
        await optOut(tx, m.counterparty_id, `Unsubscribe link in message ${rfcMessageId}`);
        await touchParty(tx, m.counterparty_id);
      }
      return true;
    });
}

export interface InboundMail {
  rfcMessageId: string;
  /** Message-IDs it refers to: In-Reply-To, References, and any of ours quoted in a bounce. */
  references: string[];
  inReplyTo: string | null;
  from: string;
  to: string | null;
  subject: string;
  text: string;
  classification: InboundClass;
  injection: boolean;
  receivedAt: string;
}

/**
 * Files an incoming message in its conversation: by the messages it refers
 * to, else the sender's latest conversation. Mail that belongs to no
 * conversation is not stored (it stays in the mailbox). An opt-out records
 * consent opted_out; a bounce marks the address bounced; both cancel what
 * is still queued to that contact.
 */
export async function recordInbound(mail: InboundMail): Promise<{ conversationId: string; messageId: string } | null> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const dup = await tx.selectFrom("conversation_messages").select("id").where("rfc_message_id", "=", mail.rfcMessageId).executeTakeFirst();
      if (dup) return null;
      let conv: { id: string; counterparty_id: string; their_address: string } | undefined;
      if (mail.references.length) {
        conv = await tx
          .selectFrom("conversation_messages as m")
          .innerJoin("conversations as c", "c.id", "m.conversation_id")
          .select(["c.id", "c.counterparty_id", "c.their_address"])
          .where("m.rfc_message_id", "in", mail.references)
          .orderBy("m.created_at", "desc")
          .executeTakeFirst();
      }
      const from = normalizeChannel("email", mail.from);
      if (!conv && from && mail.classification !== "bounce") {
        conv = await tx.selectFrom("conversations").select(["id", "counterparty_id", "their_address"]).where("their_address", "=", from).orderBy("updated_at", "desc").executeTakeFirst();
      }
      if (!conv) return null;
      const row = await tx
        .insertInto("conversation_messages")
        .values({
          conversation_id: conv.id,
          direction: "inbound",
          status: "received",
          subject: mail.subject.slice(0, 300) || "(no subject)",
          body_text: mail.text.slice(0, MAX_BODY),
          rfc_message_id: mail.rfcMessageId,
          in_reply_to: mail.inReplyTo,
          from_address: from ?? mail.from.slice(0, 300),
          to_address: mail.to,
          classification: mail.classification,
          injection_flag: mail.injection,
          received_at: mail.receivedAt,
          // Automatic replies need no one's attention.
          reviewed_at: mail.classification === "auto_reply" ? sql<string>`now()` : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (mail.classification === "bounce") {
        await tx.updateTable("contact_channels").set({ status: "bounced" }).where("counterparty_id", "=", conv.counterparty_id).where("kind", "=", "email").where("normalized_value", "=", conv.their_address).execute();
        await cancelQueuedFor(tx, conv.counterparty_id, conv.their_address, "address_bounced");
      } else {
        await tx.updateTable("conversations").set({ last_inbound_at: mail.receivedAt, updated_at: sql`now()`, status: "open" }).where("id", "=", conv.id).execute();
        await touchParty(tx, conv.counterparty_id);
      }
      if (mail.classification === "opt_out") await optOut(tx, conv.counterparty_id, `Replied asking to stop (message ${mail.rfcMessageId})`);
      await audit(tx, { type: "system", id: null }, `outreach.received.${mail.classification}`, row.id);
      await enqueueEvent(tx, {
        eventName: "outreach.reply_received.v1",
        aggregateType: "conversation",
        aggregateId: conv.id,
        idempotencyKey: `outreach.reply_received:${row.id}`,
        payload: { conversationId: conv.id, messageId: row.id, counterpartyId: conv.counterparty_id, classification: mail.classification, injection: mail.injection },
      });
      return { conversationId: conv.id, messageId: row.id };
    });
}

export async function markInboundReviewed(messageId: string, actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const r = await tx
        .updateTable("conversation_messages")
        .set({ reviewed_at: sql`now()`, reviewed_by: actor.id })
        .where("id", "=", messageId)
        .where("direction", "=", "inbound")
        .where("reviewed_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (r) await audit(tx, actor, "outreach.reviewed", messageId);
    });
}

export async function setConversationStatus(conversationId: string, status: "open" | "closed", actor: Actor): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const r = await tx.updateTable("conversations").set({ status, updated_at: sql`now()` }).where("id", "=", conversationId).returning("id").executeTakeFirst();
      if (!r) throw new OutreachError("not_found", "Conversation not found");
      await appendAuditEvent(tx, { actorType: actor.type, actorId: actor.id, action: `outreach.conversation_${status}`, entityType: "conversation", entityId: conversationId });
    });
}

export async function getConversation(conversationId: string): Promise<(ConversationRow & { messages: MessageRow[] }) | null> {
  const db = getDb();
  const conv = await db.selectFrom("conversations as c").innerJoin("counterparties as p", "p.id", "c.counterparty_id").select(CONVERSATION_COLUMNS).where("c.id", "=", conversationId).executeTakeFirst();
  if (!conv) return null;
  const messages = await db.selectFrom("conversation_messages as m").select(MESSAGE_COLUMNS).where("m.conversation_id", "=", conversationId).orderBy("m.created_at").execute();
  return { ...cast<ConversationRow>(conv), messages: cast<MessageRow[]>(messages) };
}

/** A message with what the approver must see: the content hash of its current text. */
export async function getMessage(messageId: string): Promise<(MessageRow & { counterparty_id: string; current_hash: string }) | null> {
  const row = await getDb()
    .selectFrom("conversation_messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .select([...MESSAGE_COLUMNS, "c.counterparty_id"])
    .where("m.id", "=", messageId)
    .executeTakeFirst();
  if (!row) return null;
  const m = cast<MessageRow & { counterparty_id: string }>(row);
  return { ...m, current_hash: outreachContentHash({ to: m.to_address ?? "", subject: m.subject, body: m.body_text }) };
}

export async function listConversationsForParty(partyId: string): Promise<ConversationRow[]> {
  const rows = await getDb()
    .selectFrom("conversations as c")
    .innerJoin("counterparties as p", "p.id", "c.counterparty_id")
    .select(CONVERSATION_COLUMNS)
    .where("c.counterparty_id", "=", partyId)
    .orderBy("c.updated_at", "desc")
    .execute();
  return cast<ConversationRow[]>(rows);
}

export interface InboxItem {
  conversation_id: string;
  message_id: string | null;
  party_id: string;
  party_name: string;
  their_address: string;
  subject: string;
  status: string;
  classification: string | null;
  error: string | null;
  at: string;
}

/**
 * The operator's outreach inbox (PRD FR-07): drafts to approve, queued,
 * replies needing review, conversations awaiting a response, and exceptions
 * (failed sends, sends stuck mid-way, bounces).
 */
export async function outreachInbox(): Promise<{ drafts: InboxItem[]; queued: InboxItem[]; needsReview: InboxItem[]; awaiting: InboxItem[]; exceptions: InboxItem[]; sentLast24h: number }> {
  const db = getDb();
  const base = () =>
    db
      .selectFrom("conversation_messages as m")
      .innerJoin("conversations as c", "c.id", "m.conversation_id")
      .innerJoin("counterparties as p", "p.id", "c.counterparty_id")
      .select([
        "c.id as conversation_id",
        "m.id as message_id",
        "p.id as party_id",
        sql<string>`coalesce(p.display_name, p.normalized_name)`.as("party_name"),
        "c.their_address",
        "m.subject",
        "m.status",
        "m.classification",
        "m.error",
        sql<string>`coalesce(m.received_at, m.sent_at, m.queued_at, m.created_at)::text`.as("at"),
      ]);
  const [drafts, queued, needsReview, exceptions, awaiting, sent] = await Promise.all([
    base().where("m.direction", "=", "outbound").where("m.status", "=", "draft").orderBy("m.created_at", "desc").limit(100).execute(),
    base().where("m.direction", "=", "outbound").where("m.status", "in", ["queued", "sending"]).where(sql<boolean>`not (m.status = 'sending' and m.sent_at < now() - interval '15 minutes')`).orderBy("m.queued_at").limit(100).execute(),
    base().where("m.direction", "=", "inbound").where("m.reviewed_at", "is", null).where("m.classification", "in", ["reply", "opt_out"]).orderBy("m.received_at", "desc").limit(100).execute(),
    base()
      .where((eb) =>
        eb.or([
          eb.and([eb("m.status", "=", "failed"), eb(sql<string>`m.created_at`, ">", sql<string>`now() - interval '30 days'`)]),
          eb.and([eb("m.status", "=", "sending"), eb(sql<string>`m.sent_at`, "<", sql<string>`now() - interval '15 minutes'`)]),
          eb.and([eb("m.classification", "=", "bounce"), eb("m.reviewed_at", "is", null)]),
        ]),
      )
      .orderBy("m.created_at", "desc")
      .limit(100)
      .execute(),
    db
      .selectFrom("conversations as c")
      .innerJoin("counterparties as p", "p.id", "c.counterparty_id")
      .select([
        "c.id as conversation_id",
        sql<string | null>`null`.as("message_id"),
        "p.id as party_id",
        sql<string>`coalesce(p.display_name, p.normalized_name)`.as("party_name"),
        "c.their_address",
        "c.subject",
        "c.status",
        sql<string | null>`null`.as("classification"),
        sql<string | null>`null`.as("error"),
        sql<string>`c.last_outbound_at::text`.as("at"),
      ])
      .where("c.status", "=", "open")
      .where("c.last_outbound_at", "is not", null)
      .where(sql<boolean>`(c.last_inbound_at is null or c.last_inbound_at < c.last_outbound_at)`)
      .orderBy("c.last_outbound_at", "desc")
      .limit(100)
      .execute(),
    db
      .selectFrom("conversation_messages")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("direction", "=", "outbound")
      .where("status", "in", ["sending", "sent"])
      .where(sql<boolean>`sent_at > now() - interval '24 hours'`)
      .executeTakeFirstOrThrow(),
  ]);
  return { drafts: cast(drafts), queued: cast(queued), needsReview: cast(needsReview), awaiting: cast(awaiting), exceptions: cast(exceptions), sentLast24h: sent.n };
}

/** Marks an exception handled: a stuck send the operator checked, a bounce seen. */
export async function resolveException(messageId: string, actor: Actor, outcome: "sent" | "failed" | "seen"): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (tx) => {
      const m = await tx.selectFrom("conversation_messages").select(["id", "status", "direction"]).where("id", "=", messageId).forUpdate().executeTakeFirst();
      if (!m) throw new OutreachError("not_found", "Message not found");
      if (m.direction === "inbound") {
        await tx.updateTable("conversation_messages").set({ reviewed_at: sql`now()`, reviewed_by: actor.id }).where("id", "=", messageId).execute();
      } else if (m.status === "sending" && outcome !== "seen") {
        // The operator checked the mailbox's Sent folder.
        await tx.updateTable("conversation_messages").set({ status: outcome, error: outcome === "failed" ? "marked failed by operator" : null }).where("id", "=", messageId).execute();
      } else if (m.status === "failed") {
        await tx.updateTable("conversation_messages").set({ status: "cancelled" }).where("id", "=", messageId).execute();
      }
      await audit(tx, actor, `outreach.exception_${outcome}`, messageId);
    });
}

export async function getMailboxState(mailbox: string): Promise<{ uidValidity: bigint; lastUid: number } | null> {
  const r = await getDb().selectFrom("outreach_mailbox_state").select(["uid_validity", "last_uid"]).where("mailbox", "=", mailbox).executeTakeFirst();
  return r ? { uidValidity: BigInt(r.uid_validity), lastUid: Number(r.last_uid) } : null;
}

export async function saveMailboxState(mailbox: string, uidValidity: bigint, lastUid: number): Promise<void> {
  await getDb()
    .insertInto("outreach_mailbox_state")
    .values({ mailbox, uid_validity: uidValidity.toString(), last_uid: lastUid, polled_at: sql<string>`now()` })
    .onConflict((oc) => oc.column("mailbox").doUpdateSet({ uid_validity: uidValidity.toString(), last_uid: lastUid, polled_at: sql`now()` }))
    .execute();
}
