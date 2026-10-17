import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Email outreach rules (PRD v2 FR-07, ADR-045), pure so they can be tested
 * without a mailbox: what the approver signs off on, the footer every
 * message carries (sender identity, postal address, opt-out), the
 * unsubscribe token, the sending window and how a reply is classified.
 */

/** What an approval covers: this recipient, this subject, this body. */
export function outreachContentHash(m: { to: string; subject: string; body: string }): string {
  return createHash("sha256").update(JSON.stringify([m.to.trim().toLowerCase(), m.subject, m.body])).digest("hex");
}

/** The body as sent: the approved text, then the sender's identity, postal address and the opt-out (CAN-SPAM). */
export function renderOutreachText(m: { body: string; fromName: string | null; postalAddress: string; unsubscribeUrl: string }): string {
  const footer = [m.fromName, m.postalAddress, `Not interested? Reply "unsubscribe" or open ${m.unsubscribeUrl} and you won't hear from us again.`].filter(Boolean).join("\n");
  return `${m.body.trimEnd()}\n\n--\n${footer}\n`;
}

/** An RFC 5322 Message-ID on the sending domain. */
export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "localhost";
  return `<${Date.now().toString(36)}.${randomBytes(9).toString("hex")}@${domain}>`;
}

const UNSUB_PREFIX = "outreach-unsubscribe:";

/** A token naming one sent message; whoever holds it can opt that recipient out, nothing more. */
export function signUnsubscribe(secret: string, messageId: string): string {
  const mac = createHmac("sha256", secret).update(UNSUB_PREFIX + messageId).digest("base64url").slice(0, 32);
  return `${Buffer.from(messageId).toString("base64url")}.${mac}`;
}

export function verifyUnsubscribe(secret: string, token: string): string | null {
  const [idPart, mac] = token.split(".");
  if (!idPart || !mac) return null;
  let messageId: string;
  try {
    messageId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = Buffer.from(createHmac("sha256", secret).update(UNSUB_PREFIX + messageId).digest("base64url").slice(0, 32));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected) ? messageId : null;
}

export interface SendWindow {
  start: number;
  end: number;
  timezone: string;
  weekends: boolean;
}

/** Whether now is inside the sending hours (local to the window's time zone). */
export function withinSendWindow(now: Date, w: SendWindow): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: w.timezone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  if (!w.weekends && (weekday === "Sat" || weekday === "Sun")) return false;
  return hour >= w.start && hour < w.end;
}

export type InboundClass = "reply" | "opt_out" | "bounce" | "auto_reply";

/** The new part of a reply, without the quoted thread below it. */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/i.test(line.trim())) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|messaging)|do not (email|contact)|don'?t (email|contact)|opt[- ]?out)\b|^\s*stop\s*$/i;

/**
 * What an incoming message is: a delivery failure, an automatic reply, a
 * request to stop, or a person's reply. Only a person's reply (or an
 * opt-out) needs the operator.
 */
export function classifyInbound(m: { from: string; subject: string; text: string; headers: Record<string, string | undefined> }): InboundClass {
  const from = m.from.toLowerCase();
  const contentType = (m.headers["content-type"] ?? "").toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(from) || contentType.includes("report-type=delivery-status") || /^(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)/i.test(m.subject)) return "bounce";
  const autoSubmitted = (m.headers["auto-submitted"] ?? "").toLowerCase();
  if ((autoSubmitted && autoSubmitted !== "no") || m.headers["x-autoreply"] || m.headers["x-autorespond"] || /^(auto(matic)?[- ]?reply|out of (the )?office|away:|autoreply)/i.test(m.subject)) return "auto_reply";
  if (OPT_OUT.test(replyText(m.text)) || /^\s*(unsubscribe|stop)\s*$/i.test(m.subject)) return "opt_out";
  return "reply";
}

/** Message-IDs this message answers (In-Reply-To first, then References, newest first). */
export function referencedIds(inReplyTo: string | undefined | null, references: string | string[] | undefined | null): string[] {
  const refs = Array.isArray(references) ? references.join(" ") : (references ?? "");
  const ids = `${inReplyTo ?? ""} ${refs.split(/\s+/).reverse().join(" ")}`.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids)];
}
