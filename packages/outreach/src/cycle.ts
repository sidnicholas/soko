import { simpleParser, type AddressObject } from "mailparser";
import { getConfig } from "@opportunity-os/config";
import { claimNextOutbound, getMailboxState, markOutboundFailed, markOutboundSent, recordInbound, saveMailboxState } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { classifyInbound, referencedIds, renderOutreachText, signUnsubscribe, withinSendWindow, type SendWindow } from "@opportunity-os/relationship";
import { detectInjection } from "@opportunity-os/risk";
import { imapReader, smtpSender, type MailboxSettings, type MailReader, type MailSender } from "./mail";

const log = createLogger("outreach");

export interface OutreachSettings {
  mailbox: MailboxSettings;
  fromName: string | null;
  postalAddress: string;
  /** Where the unsubscribe link points: {base}/v1/outreach/unsubscribe?t=... */
  publicApiBaseUrl: string;
  unsubscribeSecret: string;
  dailyCap: number;
  minGapHours: number;
  window: SendWindow;
}

/** What is missing before anything can be sent (empty = ready). */
export function outreachMissing(): string[] {
  const cfg = getConfig();
  const o = cfg.outreach;
  return [
    !o.address && "OUTREACH_EMAIL_ADDRESS",
    !o.password && "OUTREACH_EMAIL_PASSWORD",
    !o.postalAddress && "OUTREACH_POSTAL_ADDRESS",
    !cfg.notifications.publicApiBaseUrl && "PUBLIC_API_BASE_URL",
  ].filter((x): x is string => !!x);
}

export function outreachSettings(): OutreachSettings | null {
  if (outreachMissing().length) return null;
  const cfg = getConfig();
  const o = cfg.outreach;
  return {
    mailbox: { address: o.address!, password: o.password!, smtp: o.smtp, imap: o.imap },
    fromName: o.fromName ?? null,
    postalAddress: o.postalAddress!,
    publicApiBaseUrl: cfg.notifications.publicApiBaseUrl!.replace(/\/+$/, ""),
    unsubscribeSecret: cfg.security.approvalTokenSecret,
    dailyCap: o.dailyCap,
    minGapHours: o.minGapHours,
    window: { ...o.sendHours, timezone: o.timezone, weekends: o.weekends },
  };
}

export function unsubscribeUrl(s: OutreachSettings, rfcMessageId: string): string {
  return `${s.publicApiBaseUrl}/v1/outreach/unsubscribe?t=${encodeURIComponent(signUnsubscribe(s.unsubscribeSecret, rfcMessageId))}`;
}

/**
 * Sends approved messages that may go now (window, daily cap, per-contact
 * gap; see claimNextOutbound), at most `max`. Each is claimed before the
 * SMTP call, so a crash mid-send leaves it 'sending' for the operator,
 * never sent twice.
 */
export async function sendDue(s: OutreachSettings, sender: MailSender, opts: { max?: number; now?: () => Date; onlyMessageId?: string } = {}): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  const result = { sent: 0, failed: 0 };
  for (let i = 0; i < (opts.max ?? 10); i++) {
    if (!withinSendWindow(now(), s.window)) break;
    const m = await claimNextOutbound({ fromAddress: s.mailbox.address, dailyCap: s.dailyCap, minGapHours: s.minGapHours, now: now() });
    if (!m) break;
    const unsub = unsubscribeUrl(s, m.rfcMessageId);
    try {
      await sender.send({
        from: s.mailbox.address,
        to: m.to,
        subject: m.subject,
        text: renderOutreachText({ body: m.body, fromName: s.fromName, postalAddress: s.postalAddress, unsubscribeUrl: unsub }),
        messageId: m.rfcMessageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
        headers: {
          "List-Unsubscribe": `<${unsub}>, <mailto:${s.mailbox.address}?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await markOutboundSent(m.id);
      result.sent++;
    } catch (err) {
      log.warn({ messageId: m.id, err: String(err) }, "outreach.send_failed");
      await markOutboundFailed(m.id, String(err));
      result.failed++;
    }
  }
  if (result.sent || result.failed) log.info(result, "outreach.sent");
  return result;
}

const firstAddress = (a: AddressObject | AddressObject[] | undefined): string | null => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value).find((v) => v.address)?.address ?? null;
};

/**
 * Reads new mail from the inbox and files replies, opt-outs, bounces and
 * automatic replies in their conversations. Mail that matches no
 * conversation is left alone in the mailbox.
 */
export async function pollReplies(s: OutreachSettings, reader: MailReader, opts: { max?: number } = {}): Promise<{ read: number; filed: number }> {
  const folder = "INBOX";
  const known = await getMailboxState(folder);
  const { uidValidity, messages } = await reader.fetchNew(folder, known, { sinceDays: 14, max: opts.max ?? 200 });
  const ownDomain = s.mailbox.address.split("@")[1]!.toLowerCase();
  const ownIds = new RegExp(`<[^<>\\s]+@${ownDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "gi");
  let filed = 0;
  let lastUid = known && known.uidValidity === uidValidity ? known.lastUid : 0;
  for (const raw of messages) {
    try {
      const mail = await simpleParser(raw.source);
      const from = firstAddress(mail.from) ?? "";
      if (from.toLowerCase() === s.mailbox.address) continue;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of mail.headers) headers[k.toLowerCase()] = typeof v === "string" ? v : k === "content-type" && v && typeof v === "object" && "value" in v ? `${(v as { value: string }).value}; ${Object.entries((v as { params?: Record<string, string> }).params ?? {}).map(([pk, pv]) => `${pk}=${pv}`).join("; ")}` : undefined;
      const text = mail.text ?? "";
      const subject = mail.subject ?? "";
      const classification = classifyInbound({ from, subject, text, headers });
      const refs = referencedIds(mail.inReplyTo, mail.references);
      // A bounce quotes our Message-ID in its body or attached original, not its headers.
      if (classification === "bounce") refs.push(...new Set(raw.source.toString("latin1").match(ownIds) ?? []));
      const r = await recordInbound({
        rfcMessageId: mail.messageId ?? `<imap-${uidValidity}-${raw.uid}@${ownDomain}>`,
        references: [...new Set(refs)],
        inReplyTo: mail.inReplyTo ?? null,
        from,
        to: firstAddress(mail.to),
        subject,
        text,
        classification,
        injection: detectInjection(`${subject}\n${text}`).length > 0,
        receivedAt: (mail.date ?? new Date()).toISOString(),
      });
      if (r) filed++;
    } catch (err) {
      log.warn({ uid: raw.uid, err: String(err) }, "outreach.inbound_failed");
    }
    lastUid = Math.max(lastUid, raw.uid);
  }
  await saveMailboxState(folder, uidValidity, lastUid);
  if (messages.length) log.info({ read: messages.length, filed }, "outreach.polled");
  return { read: messages.length, filed };
}

/** One sweep (worker-lifecycle): send what is due, then read replies. A no-op until the mailbox is configured. */
export async function outreachCycle(deps: { sender?: MailSender; reader?: MailReader } = {}): Promise<void> {
  const s = outreachSettings();
  if (!s) return;
  await sendDue(s, deps.sender ?? smtpSender(s.mailbox, s.fromName, (err) => log.warn({ err: String(err) }, "outreach.sent_copy_failed")));
  const reader = deps.reader ?? imapReader(s.mailbox);
  try {
    await pollReplies(s, reader);
  } finally {
    await reader.close();
  }
}
