import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  approveMessage,
  closeDb,
  createDraft,
  createParty,
  getConversation,
  getDb,
  getMessage,
  getPartyDetail,
  outreachInbox,
  recordConsent,
  resolveException,
  unsubscribeByMessageId,
  updateDraft,
  type Actor,
} from "@opportunity-os/db";
import { pollReplies, sendDue, unsubscribeUrl, type MailReader, type OutgoingMail, type OutreachSettings } from "@opportunity-os/outreach";
import { mayContact, verifyUnsubscribe } from "@opportunity-os/relationship";

/**
 * PRD v2 FR-07 / ADR-045 against a live Postgres: nothing is sent without
 * recorded consent and an approval of the exact text; the approval goes
 * stale when the draft changes; each message is claimed and sent once with
 * identity, postal address and opt-out; caps and the per-contact gap hold;
 * replies thread by Message-ID; opt-outs (reply or link) and bounces stop
 * further sends. Mailbox stubbed.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);
const OP: Actor = { type: "user", id: randomUUID() };
const FROM = `sam@out-${RUN}.example.com`;

const settings = (over: Partial<OutreachSettings> = {}): OutreachSettings => ({
  mailbox: { address: FROM, password: "x", smtp: { host: "smtp", port: 465 }, imap: { host: "imap", port: 993 } },
  fromName: "Sam Lee",
  postalAddress: "1 Main St, Detroit, MI 48201",
  publicApiBaseUrl: "https://api.example.com",
  unsubscribeSecret: "test-secret",
  dailyCap: 100,
  minGapHours: 72,
  window: { start: 0, end: 24, timezone: "UTC", weekends: true },
  ...over,
});

function stubSender(fail = false) {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(m: OutgoingMail) {
      if (fail) throw new Error("550 mailbox unavailable");
      sent.push(m);
    },
  };
}

function stubReader(mails: string[], uidValidity = 7n): MailReader {
  return {
    async fetchNew(_folder, known) {
      const all = mails.map((m, i) => ({ uid: i + 1, source: Buffer.from(m) }));
      return { uidValidity, messages: known && known.uidValidity === uidValidity ? all.filter((m) => m.uid > known.lastUid) : all };
    },
    async close() {},
  };
}

const rawMail = (h: Record<string, string>, body: string) =>
  `${Object.entries({ Date: new Date().toUTCString(), "Content-Type": "text/plain; charset=utf-8", ...h }).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}\r\n`;

async function contact(name: string, consent = true) {
  const email = `${name}-${RUN}@acme-${RUN}.example.com`;
  const p = await createParty({ type: "person", displayName: name, channels: [{ kind: "email", value: email }] }, OP);
  if (consent) await recordConsent(p.party.id, { channelKind: "email", purpose: "outreach", status: "granted", basis: "public_business_contact", evidence: "Listed on their own wanted ad" }, OP);
  return { id: p.party.id, email };
}

async function approve(messageId: string) {
  const m = (await getMessage(messageId))!;
  return approveMessage(messageId, m.current_hash, OP);
}

describe.skipIf(!HAS_DB)("email outreach (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("needs consent and an approval of the exact text, then sends once with the footer and headers", async () => {
    const jo = await contact("jo", false);
    const d = await createDraft({ partyId: jo.id, toAddress: jo.email, subject: "Your pallets", body: "Hi Jo, are the pallets still available?" }, OP);
    await expect(approve(d.messageId)).rejects.toThrow(/no_consent_recorded/);

    await recordConsent(jo.id, { channelKind: "email", purpose: "outreach", status: "granted", basis: "public_business_contact", evidence: "Business email on their listing" }, OP);
    const shown = (await getMessage(d.messageId))!.current_hash;
    await updateDraft(d.messageId, { body: "Hi Jo, are the pallets still available? What quantity?" }, OP);
    await expect(approveMessage(d.messageId, shown, OP)).rejects.toThrow(/changed since/);
    await approve(d.messageId);
    await expect(approve(d.messageId)).rejects.toThrow(/already queued/);

    const sender = stubSender();
    expect(await sendDue(settings(), sender)).toEqual({ sent: 1, failed: 0 });
    expect(await sendDue(settings(), sender)).toEqual({ sent: 0, failed: 0 });
    const out = sender.sent[0]!;
    expect(out.to).toBe(jo.email);
    expect(out.text).toContain("What quantity?\n\n--\nSam Lee\n1 Main St, Detroit, MI 48201\n");
    expect(out.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(out.headers["List-Unsubscribe"]).toContain(`mailto:${FROM}?subject=unsubscribe`);
    const msg = (await getMessage(d.messageId))!;
    expect(msg.status).toBe("sent");
    expect(msg.rfc_message_id).toBe(out.messageId);
    expect(msg.approved_by).toBe(OP.id);
    const audit = await getDb().selectFrom("audit_events").select("action").where("entity_id", "=", d.messageId).execute();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["outreach.drafted", "outreach.edited", "outreach.approved", "outreach.sent"]));
    const ev = await getDb().selectFrom("outbox").select(["event_name", "payload"]).where("aggregate_id", "=", d.conversationId).execute();
    expect(ev.map((e) => e.event_name).sort()).toEqual(["outreach.scheduled.v1", "outreach.sent.v1"]);
    expect(JSON.stringify(ev.map((e) => e.payload))).not.toContain(jo.email);
    expect((await outreachInbox()).awaiting.map((a) => a.conversation_id)).toContain(d.conversationId);

    // A follow-up within the gap waits; a reply lifts the wait.
    const f = await createDraft({ partyId: jo.id, conversationId: d.conversationId, body: "Following up." }, OP);
    await approve(f.messageId);
    expect(await sendDue(settings(), sender)).toEqual({ sent: 0, failed: 0 });
    expect((await getMessage(f.messageId))!.status).toBe("queued");
    expect((await getMessage(f.messageId))!.in_reply_to).toBe(out.messageId);

    const reply = rawMail({ From: `Jo <${jo.email}>`, To: FROM, Subject: "Re: Your pallets", "Message-ID": `<r1-${RUN}@acme.example.com>`, "In-Reply-To": out.messageId, References: out.messageId }, `Yes, 40 pallets.\r\n\r\nOn Fri, Oct 16, 2026 at 10:00 AM Sam <${FROM}> wrote:\r\n> Hi Jo\r\n> Reply "unsubscribe"`);
    const unrelated = rawMail({ From: `x-${RUN}@else.example.com`, To: FROM, Subject: "Hello", "Message-ID": `<u1-${RUN}@else.example.com>` }, "Unrelated");
    const reader = stubReader([reply, unrelated]);
    expect(await pollReplies(settings(), reader)).toEqual({ read: 2, filed: 1 });
    expect(await pollReplies(settings(), reader)).toEqual({ read: 0, filed: 0 });
    const conv = (await getConversation(d.conversationId))!;
    const inbound = conv.messages.find((m) => m.direction === "inbound")!;
    expect(inbound.classification).toBe("reply");
    expect((await outreachInbox()).needsReview.map((n) => n.message_id)).toContain(inbound.id);
    const next = stubSender();
    expect(await sendDue(settings(), next)).toEqual({ sent: 1, failed: 0 });
    expect(next.sent[0]!.inReplyTo).toBe(out.messageId);
    expect(next.sent[0]!.references).toEqual([out.messageId, `<r1-${RUN}@acme.example.com>`]);
  });

  it("an opt-out reply or the unsubscribe link stops everything queued", async () => {
    const al = await contact("al");
    const d = await createDraft({ partyId: al.id, toAddress: al.email, subject: "Your listing", body: "Hi Al" }, OP);
    await approve(d.messageId);
    const sender = stubSender();
    await sendDue(settings(), sender);
    const sentId = sender.sent[0]!.messageId;

    const token = new URL(unsubscribeUrl(settings(), sentId)).searchParams.get("t")!;
    expect(verifyUnsubscribe("test-secret", token)).toBe(sentId);
    const queued = await createDraft({ partyId: al.id, conversationId: d.conversationId, body: "One more thing" }, OP);
    expect(await unsubscribeByMessageId(sentId)).toBe(true);
    expect(await unsubscribeByMessageId(sentId)).toBe(true);
    expect((await getMessage(queued.messageId))!.status).toBe("cancelled");
    const detail = (await getPartyDetail(al.id))!;
    expect(mayContact(detail.consents, "email", "outreach").reason).toBe("consent_opted_out");
    expect(detail.consents.filter((c) => c.status === "opted_out")).toHaveLength(1);
    const again = await createDraft({ partyId: al.id, conversationId: d.conversationId, body: "Hello?" }, OP);
    await expect(approve(again.messageId)).rejects.toThrow(/consent_opted_out/);

    const bo = await contact("bo");
    const b = await createDraft({ partyId: bo.id, toAddress: bo.email, subject: "Question", body: "Hi Bo" }, OP);
    await approve(b.messageId);
    const s2 = stubSender();
    await sendDue(settings(), s2);
    const stop = rawMail({ From: bo.email, To: FROM, Subject: "Re: Question", "Message-ID": `<s1-${RUN}@acme.example.com>`, "In-Reply-To": s2.sent[0]!.messageId }, "Please remove me from your list.");
    await pollReplies(settings(), stubReader([stop], 8n));
    expect(mayContact((await getPartyDetail(bo.id))!.consents, "email", "outreach").reason).toBe("consent_opted_out");
  });

  it("a bounce marks the address and quoted ids find the conversation; failures and caps", async () => {
    const cy = await contact("cy");
    const d = await createDraft({ partyId: cy.id, toAddress: cy.email, subject: "Hi", body: "Hi Cy" }, OP);
    await approve(d.messageId);
    const sender = stubSender();
    await sendDue(settings(), sender);
    const id = sender.sent[0]!.messageId;
    const bounce = rawMail(
      { From: "MAILER-DAEMON@mx.example.net", To: FROM, Subject: "Undelivered Mail Returned to Sender", "Message-ID": `<b1-${RUN}@mx.example.net>` },
      `This is the mail system.\r\n<${cy.email}>: host said: 550 no such user\r\n\r\nMessage-ID: ${id}\r\n`,
    );
    expect(await pollReplies(settings(), stubReader([bounce], 9n))).toEqual({ read: 1, filed: 1 });
    const ch = (await getPartyDetail(cy.id))!.channels.find((c) => c.kind === "email")!;
    expect(ch.status).toBe("bounced");
    const inbox = await outreachInbox();
    const ex = inbox.exceptions.find((e) => e.conversation_id === d.conversationId)!;
    expect(ex.classification).toBe("bounce");
    await resolveException(ex.message_id!, OP, "seen");
    expect((await outreachInbox()).exceptions.map((e) => e.message_id)).not.toContain(ex.message_id);

    // The server refuses: failed, not retried.
    const di = await contact("di");
    const f = await createDraft({ partyId: di.id, toAddress: di.email, subject: "Hi", body: "Hi Di" }, OP);
    await approve(f.messageId);
    expect(await sendDue(settings(), stubSender(true))).toEqual({ sent: 0, failed: 1 });
    expect((await getMessage(f.messageId))!.status).toBe("failed");
    expect(await sendDue(settings(), stubSender())).toEqual({ sent: 0, failed: 0 });

    // Daily cap and sending window.
    const ed = await contact("ed");
    const g = await createDraft({ partyId: ed.id, toAddress: ed.email, subject: "Hi", body: "Hi Ed" }, OP);
    await approve(g.messageId);
    const sentToday = (await outreachInbox()).sentLast24h;
    expect(await sendDue(settings({ dailyCap: sentToday }), stubSender())).toEqual({ sent: 0, failed: 0 });
    expect(await sendDue(settings({ window: { start: 0, end: 0, timezone: "UTC", weekends: true } }), stubSender())).toEqual({ sent: 0, failed: 0 });
    expect(await sendDue(settings(), stubSender())).toEqual({ sent: 1, failed: 0 });
  });
});
