import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

/**
 * The mailbox (ADR-045): SMTP to send, IMAP to read replies and keep a copy
 * of what was sent in the Sent folder. Hostinger by default; any provider
 * with SMTP and IMAP works. Injected into the cycle so tests use stubs.
 */

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
}

export interface MailSender {
  /** Resolves once the server accepted the message; throws when it refused. */
  send(mail: OutgoingMail): Promise<void>;
}

export interface FetchedMail {
  uid: number;
  source: Buffer;
}

export interface MailReader {
  /**
   * New messages in the folder: after `lastUid` when the folder's UID
   * validity is unchanged, else those received in the last `sinceDays`.
   */
  fetchNew(folder: string, known: { uidValidity: bigint; lastUid: number } | null, opts: { sinceDays: number; max: number }): Promise<{ uidValidity: bigint; messages: FetchedMail[] }>;
  close(): Promise<void>;
}

export interface MailboxSettings {
  address: string;
  password: string;
  smtp: { host: string; port: number };
  imap: { host: string; port: number };
}

async function compose(mail: OutgoingMail, fromName: string | null): Promise<Buffer> {
  return new MailComposer({
    from: fromName ? { name: fromName, address: mail.from } : mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    messageId: mail.messageId,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
    ...(mail.references.length ? { references: mail.references } : {}),
    headers: mail.headers,
  })
    .compile()
    .build();
}

function imapClient(s: MailboxSettings): ImapFlow {
  return new ImapFlow({ host: s.imap.host, port: s.imap.port, secure: s.imap.port === 993, auth: { user: s.address, pass: s.password }, logger: false });
}

/** SMTP sender that also files a copy in the mailbox's Sent folder (best effort). */
export function smtpSender(s: MailboxSettings, fromName: string | null, onCopyFailed: (err: unknown) => void = () => {}): MailSender {
  let transporter: Transporter | undefined;
  return {
    async send(mail) {
      transporter ??= nodemailer.createTransport({ host: s.smtp.host, port: s.smtp.port, secure: s.smtp.port === 465, auth: { user: s.address, pass: s.password } });
      const raw = await compose(mail, fromName);
      await transporter.sendMail({ envelope: { from: mail.from, to: [mail.to] }, raw });
      const client = imapClient(s);
      try {
        await client.connect();
        const folders = await client.list();
        const sent = folders.find((f) => f.specialUse === "\\Sent")?.path ?? folders.find((f) => /^(inbox\.)?sent( items| messages)?$/i.test(f.path))?.path;
        if (sent) await client.append(sent, raw, ["\\Seen"]);
      } catch (err) {
        onCopyFailed(err);
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
}

export function imapReader(s: MailboxSettings): MailReader {
  const client = imapClient(s);
  let connected = false;
  return {
    async fetchNew(folder, known, opts) {
      if (!connected) {
        await client.connect();
        connected = true;
      }
      const lock = await client.getMailboxLock(folder);
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error(`mailbox ${folder} not open`);
        const uidValidity = BigInt(mailbox.uidValidity);
        let uids: number[];
        if (known && known.uidValidity === uidValidity) {
          uids = mailbox.uidNext > known.lastUid + 1 ? ((await client.search({ uid: `${known.lastUid + 1}:*` }, { uid: true })) || []) : [];
          uids = uids.filter((u) => u > known.lastUid);
        } else {
          uids = (await client.search({ since: new Date(Date.now() - opts.sinceDays * 86_400_000) }, { uid: true })) || [];
        }
        uids = uids.sort((a, b) => a - b).slice(0, opts.max);
        const messages: FetchedMail[] = [];
        if (uids.length) {
          for await (const m of client.fetch(uids.join(","), { uid: true, source: true }, { uid: true })) {
            if (m.source) messages.push({ uid: m.uid, source: m.source });
          }
        }
        return { uidValidity, messages: messages.sort((a, b) => a.uid - b.uid) };
      } finally {
        lock.release();
      }
    },
    async close() {
      if (connected) await client.logout().catch(() => {});
    },
  };
}
