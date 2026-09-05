import { describe, it, expect } from "vitest";
import { telegramMessageToSignal } from "./webhooks.service";

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
