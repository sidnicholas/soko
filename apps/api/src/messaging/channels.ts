import nodemailer, { type Transporter } from "nodemailer";

/**
 * §11 messaging backlog — one outbound sender per channel, addressed by the
 * same identity shape each inbound webhook already produces (`chatId`,
 * E.164 phone, email address, WhatsApp `wa_id`). Shared by the webhook
 * ack-replies and negotiation dispatch (`../negotiations`) rather than each
 * having its own copy of the Telegram/Twilio calls.
 *
 * Returns the provider's message id when it gives one back (so callers can
 * record it, e.g. on `negotiations.outbound_message_ids`), or `undefined`
 * when unconfigured (simulated no-op, same honesty convention as the
 * settlement rails) or the provider's response didn't carry one.
 */
export interface MessageChannel {
  readonly channelId: string;
  send(identity: string, text: string): Promise<string | undefined>;
}

export class MessageChannelRegistry {
  private readonly channels = new Map<string, MessageChannel>();

  register(channel: MessageChannel): void {
    this.channels.set(channel.channelId, channel);
  }

  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  async send(channelId: string, identity: string, text: string): Promise<string | undefined> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`no message channel registered: ${channelId}`);
    return channel.send(identity, text);
  }
}

export class TelegramChannel implements MessageChannel {
  readonly channelId = "telegram";
  constructor(private readonly botToken: string | undefined) {}

  async send(identity: string, text: string): Promise<string | undefined> {
    if (!this.botToken) return undefined;
    const chatId = /^-?\d+$/.test(identity) ? Number(identity) : identity;
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = (await res.json().catch(() => undefined)) as { result?: { message_id?: number } } | undefined;
    return body?.result?.message_id !== undefined ? String(body.result.message_id) : undefined;
  }
}

export class TwilioSmsChannel implements MessageChannel {
  readonly channelId = "sms";
  constructor(
    private readonly accountSid: string | undefined,
    private readonly authToken: string | undefined,
    private readonly fromNumber: string | undefined,
  ) {}

  async send(identity: string, text: string): Promise<string | undefined> {
    if (!this.accountSid || !this.authToken || !this.fromNumber) return undefined;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
      },
      body: new URLSearchParams({ To: identity, From: this.fromNumber, Body: text }).toString(),
    });
    const body = (await res.json().catch(() => undefined)) as { sid?: string } | undefined;
    return body?.sid;
  }
}

export class EmailChannel implements MessageChannel {
  readonly channelId = "email";
  private transporter?: Transporter;

  constructor(
    private readonly smtpUrl: string | undefined,
    private readonly fromAddress: string | undefined,
    private readonly subject = "Message from Soko",
  ) {}

  async send(identity: string, text: string): Promise<string | undefined> {
    if (!this.smtpUrl || !this.fromAddress) return undefined;
    this.transporter ??= nodemailer.createTransport(this.smtpUrl);
    const info = await this.transporter.sendMail({ from: this.fromAddress, to: identity, subject: this.subject, text });
    return info.messageId;
  }
}

export class WhatsAppChannel implements MessageChannel {
  readonly channelId = "whatsapp";
  constructor(
    private readonly accessToken: string | undefined,
    private readonly phoneNumberId: string | undefined,
  ) {}

  async send(identity: string, text: string): Promise<string | undefined> {
    if (!this.accessToken || !this.phoneNumberId) return undefined;
    const res = await fetch(`https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to: identity, type: "text", text: { body: text } }),
    });
    const body = (await res.json().catch(() => undefined)) as { messages?: { id?: string }[] } | undefined;
    return body?.messages?.[0]?.id;
  }
}
