import { describe, it, expect, vi, afterEach } from "vitest";
import { EmailChannel, MessageChannelRegistry, TelegramChannel, TwilioSmsChannel, WhatsAppChannel } from "./channels";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MessageChannelRegistry", () => {
  it("dispatches to the registered channel by id", async () => {
    const registry = new MessageChannelRegistry();
    const sent: { identity: string; text: string }[] = [];
    registry.register({
      channelId: "fake",
      async send(identity, text) {
        sent.push({ identity, text });
        return "ext-1";
      },
    });
    const ref = await registry.send("fake", "user-1", "hello");
    expect(ref).toBe("ext-1");
    expect(sent).toEqual([{ identity: "user-1", text: "hello" }]);
  });

  it("throws for an unregistered channel id", async () => {
    const registry = new MessageChannelRegistry();
    await expect(registry.send("nope", "x", "y")).rejects.toThrow(/no message channel registered/);
  });
});

describe("channels are honest no-ops when unconfigured", () => {
  it("TelegramChannel", async () => {
    expect(await new TelegramChannel(undefined).send("1", "hi")).toBeUndefined();
  });
  it("TwilioSmsChannel", async () => {
    expect(await new TwilioSmsChannel(undefined, undefined, undefined).send("+1", "hi")).toBeUndefined();
  });
  it("EmailChannel", async () => {
    expect(await new EmailChannel(undefined, undefined).send("a@b.com", "hi")).toBeUndefined();
  });
  it("WhatsAppChannel", async () => {
    expect(await new WhatsAppChannel(undefined, undefined).send("1", "hi")).toBeUndefined();
  });
});

describe("configured channels call the provider API and return its message id", () => {
  it("TelegramChannel sends to api.telegram.org and returns the message id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })));
    vi.stubGlobal("fetch", fetchMock);
    const ref = await new TelegramChannel("tok").send("12345", "hi there");
    expect(ref).toBe("42");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(JSON.parse(init!.body as string)).toEqual({ chat_id: 12345, text: "hi there" });
  });

  it("TwilioSmsChannel sends via Basic auth and returns the message sid", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: "SM999" })));
    vi.stubGlobal("fetch", fetchMock);
    const ref = await new TwilioSmsChannel("AC1", "secret", "+15550000000").send("+15551234567", "hi");
    expect(ref).toBe("SM999");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/Accounts/AC1/Messages.json");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from("AC1:secret").toString("base64")}`);
  });

  it("WhatsAppChannel sends via graph.facebook.com and returns the message id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.123" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const ref = await new WhatsAppChannel("token", "phone-id").send("15551234567", "hi");
    expect(ref).toBe("wamid.123");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.facebook.com/v20.0/phone-id/messages");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer token");
  });
});
