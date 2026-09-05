import { describe, it, expect } from "vitest";
import { telegramMessageToSignal, twilioSmsToSignal } from "./webhooks.service";

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
