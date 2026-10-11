import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ebayChallengeResponse,
  parseEbaySignatureHeader,
  verifyEbaySignature,
  verifyMailgunSignature,
  verifyTwilioSignature,
} from "./webhook-signature";

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

describe("ebayChallengeResponse", () => {
  it("hashes challenge code, verification token and endpoint in that order", () => {
    const expected = createHash("sha256").update("abc123" + "token-value" + "https://api.example.com/v1/webhooks/ebay/account-deletion").digest("hex");
    expect(ebayChallengeResponse("abc123", "token-value", "https://api.example.com/v1/webhooks/ebay/account-deletion")).toBe(expected);
  });

  it("changes when the endpoint differs by a trailing slash", () => {
    expect(ebayChallengeResponse("c", "t", "https://api.example.com/x")).not.toBe(ebayChallengeResponse("c", "t", "https://api.example.com/x/"));
  });
});

describe("eBay notification signature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // eBay's getPublicKey returns the PEM on one line, with no breaks around the base64 body.
  const ebayKey = `-----BEGIN PUBLIC KEY-----${publicKey.export({ type: "spki", format: "der" }).toString("base64")}-----END PUBLIC KEY-----`;
  const body = Buffer.from(JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-1" } }));

  function header(overrides: Record<string, unknown> = {}): string {
    const signature = sign("sha1", body, privateKey).toString("base64");
    return Buffer.from(JSON.stringify({ alg: "ECDSA", kid: "key-1", signature, digest: "SHA1", ...overrides })).toString("base64");
  }

  it("accepts a body signed by the key eBay published", () => {
    const parsed = parseEbaySignatureHeader(header());
    expect(parsed).toMatchObject({ kid: "key-1", digest: "sha1" });
    expect(verifyEbaySignature(body, parsed!, ebayKey)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const parsed = parseEbaySignatureHeader(header());
    expect(verifyEbaySignature(Buffer.from(body.toString("utf8").replace("n-1", "n-2")), parsed!, ebayKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signature = sign("sha1", body, other.privateKey).toString("base64");
    expect(verifyEbaySignature(body, parseEbaySignatureHeader(header({ signature }))!, ebayKey)).toBe(false);
  });

  it("returns false instead of throwing on an unusable public key", () => {
    expect(verifyEbaySignature(body, parseEbaySignatureHeader(header())!, "not a key")).toBe(false);
  });

  it("does not parse a header that is not base64 JSON, not ECDSA, or missing fields", () => {
    expect(parseEbaySignatureHeader("%%%")).toBeUndefined();
    expect(parseEbaySignatureHeader(header({ alg: "RSA" }))).toBeUndefined();
    expect(parseEbaySignatureHeader(header({ kid: "" }))).toBeUndefined();
    expect(parseEbaySignatureHeader(header({ digest: "MD5" }))).toBeUndefined();
  });
});
