import { describe, it, expect } from "vitest";
import { mailgunInboundToSignal, telegramMessageToSignal, twilioSmsToSignal, whatsappMessageToSignal } from "./webhooks.service";

describe("telegramMessageToSignal", () => {
  it("maps a text message into a supply signal keyed by chat id", () => {
    const signal = telegramMessageToSignal({
      message_id: 42,
      text: "Selling a barely-used 27in monitor, $150",
      chat: { id: 12345 },
      from: { id: 999 },
    });
    expect(signal).toBeDefined();
    expect(signal!.channel).toBe("telegram");
    expect(signal!.kind).toBe("supply");
    expect(signal!.source_id).toBe("telegram:12345");
    expect(signal!.description).toBe("Selling a barely-used 27in monitor, $150");
    expect(signal!.raw).toEqual({ chatId: 12345, fromId: 999, messageId: 42 });
  });

  it("returns undefined for a message with no text (sticker, photo, ...)", () => {
    expect(telegramMessageToSignal({ chat: { id: 1 }, sticker: { file_id: "abc" } })).toBeUndefined();
  });

  it("returns undefined when the chat id is missing", () => {
    expect(telegramMessageToSignal({ text: "hello" })).toBeUndefined();
  });

  it("returns undefined for whitespace-only text", () => {
    expect(telegramMessageToSignal({ text: "   ", chat: { id: 1 } })).toBeUndefined();
  });
});

describe("twilioSmsToSignal", () => {
  it("maps an inbound SMS body into a supply signal keyed by the sender's number", () => {
    const signal = twilioSmsToSignal({
      From: "+15551234567",
      To: "+15557654321",
      Body: "Selling a barely-used 27in monitor, $150",
      MessageSid: "SM123",
    });
    expect(signal).toBeDefined();
    expect(signal!.channel).toBe("sms");
    expect(signal!.kind).toBe("supply");
    expect(signal!.source_id).toBe("sms:+15551234567");
    expect(signal!.description).toBe("Selling a barely-used 27in monitor, $150");
    expect(signal!.raw).toEqual({ from: "+15551234567", to: "+15557654321", messageSid: "SM123" });
  });

  it("returns undefined when Body is empty or From is missing", () => {
    expect(twilioSmsToSignal({ From: "+15551234567", Body: "  " })).toBeUndefined();
    expect(twilioSmsToSignal({ Body: "hello" })).toBeUndefined();
  });
});

describe("mailgunInboundToSignal", () => {
  it("maps an inbound email into a supply signal keyed by the sender's address", () => {
    const signal = mailgunInboundToSignal({
      sender: "seller@example.com",
      recipient: "listings@soko.example",
      subject: "Selling my monitor",
      "body-plain": "Selling a barely-used 27in monitor, $150",
      "Message-Id": "<abc@example.com>",
    });
    expect(signal).toBeDefined();
    expect(signal!.channel).toBe("email");
    expect(signal!.kind).toBe("supply");
    expect(signal!.source_id).toBe("email:seller@example.com");
    expect(signal!.description).toBe("Selling a barely-used 27in monitor, $150");
    expect(signal!.raw).toEqual({ from: "seller@example.com", subject: "Selling my monitor", messageId: "<abc@example.com>" });
  });

  it("returns undefined when body-plain is empty or sender is missing", () => {
    expect(mailgunInboundToSignal({ sender: "a@b.com", "body-plain": "  " })).toBeUndefined();
    expect(mailgunInboundToSignal({ "body-plain": "hello" })).toBeUndefined();
  });
});

describe("whatsappMessageToSignal", () => {
  function webhookBody(message: Record<string, unknown>) {
    return { entry: [{ changes: [{ value: { messages: [message] } }] }] };
  }

  it("maps the first inbound WhatsApp text message into a supply signal keyed by sender", () => {
    const signal = whatsappMessageToSignal(
      webhookBody({ from: "15551234567", id: "wamid.abc", text: { body: "Selling a barely-used 27in monitor, $150" } }),
    );
    expect(signal).toBeDefined();
    expect(signal!.channel).toBe("whatsapp");
    expect(signal!.kind).toBe("supply");
    expect(signal!.source_id).toBe("whatsapp:15551234567");
    expect(signal!.description).toBe("Selling a barely-used 27in monitor, $150");
    expect(signal!.raw).toEqual({ from: "15551234567", messageId: "wamid.abc" });
  });

  it("returns undefined for a non-text message (status update, image, ...)", () => {
    expect(whatsappMessageToSignal(webhookBody({ from: "15551234567", id: "wamid.abc" }))).toBeUndefined();
  });

  it("returns undefined for a malformed/empty webhook body", () => {
    expect(whatsappMessageToSignal({})).toBeUndefined();
    expect(whatsappMessageToSignal({ entry: [] })).toBeUndefined();
  });
});
