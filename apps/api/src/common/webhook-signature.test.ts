import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyMailgunSignature, verifyTwilioSignature } from "./webhook-signature";

function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://api.example.com/v1/webhooks/twilio-sms";
  const params = { From: "+15551234567", To: "+15557654321", Body: "hello", MessageSid: "SM123" };

  it("accepts a correctly computed signature", () => {
    const signature = twilioSignature(url, params, authToken);
    expect(verifyTwilioSignature(url, params, signature, authToken)).toBe(true);
  });

  it("rejects a signature computed with the wrong auth token", () => {
    const signature = twilioSignature(url, params, "wrong-token");
    expect(verifyTwilioSignature(url, params, signature, authToken)).toBe(false);
  });

  it("rejects a signature if the URL doesn't match what was signed", () => {
    const signature = twilioSignature(url, params, authToken);
    expect(verifyTwilioSignature("https://api.example.com/v1/webhooks/twilio-sms-other", params, signature, authToken)).toBe(false);
  });

  it("rejects a signature if a param value was tampered with", () => {
    const signature = twilioSignature(url, params, authToken);
    expect(verifyTwilioSignature(url, { ...params, Body: "tampered" }, signature, authToken)).toBe(false);
  });
});

function mailgunSignature(timestamp: string, token: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(timestamp + token, "utf8").digest("hex");
}

describe("verifyMailgunSignature", () => {
  const signingKey = "test-signing-key";
  const timestamp = "1234567890";
  const token = "a-random-token";

  it("accepts a correctly computed signature", () => {
    const signature = mailgunSignature(timestamp, token, signingKey);
    expect(verifyMailgunSignature(timestamp, token, signature, signingKey)).toBe(true);
  });

  it("rejects a signature computed with the wrong signing key", () => {
    const signature = mailgunSignature(timestamp, token, "wrong-key");
    expect(verifyMailgunSignature(timestamp, token, signature, signingKey)).toBe(false);
  });

  it("rejects a signature if the timestamp or token was tampered with", () => {
    const signature = mailgunSignature(timestamp, token, signingKey);
    expect(verifyMailgunSignature("9999999999", token, signature, signingKey)).toBe(false);
    expect(verifyMailgunSignature(timestamp, "different-token", signature, signingKey)).toBe(false);
  });
});
