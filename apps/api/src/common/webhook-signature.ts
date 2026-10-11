import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";

/**
 * Twilio signs the exact webhook URL plus every POST param (sorted by key,
 * key+value concatenated with no separator, appended to the URL) with
 * HMAC-SHA1/base64 — unlike Stripe/Circle's payload-only HMAC, the URL
 * itself is part of what's signed, so `url` must match byte-for-byte what
 * Twilio actually called (a reverse proxy rewriting scheme/host breaks
 * this). See https://www.twilio.com/docs/usage/security#validating-requests.
 */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Constant-time HMAC-SHA256 verification for inbound webhook signatures
 * (Stripe, chain callbacks). The `sha256=` prefix (GitHub/Stripe style) is
 * tolerated. Returns false on any length/format mismatch instead of throwing.
 */
export function verifyHmacSignature(secret: string, rawBody: string, provided: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = provided.startsWith("sha256=") ? provided.slice(7) : provided;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Constant-time string equality (Telegram delivers a shared secret token). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Mailgun signs inbound-route webhooks with HMAC-SHA256 over `timestamp +
 * token` (both delivered as separate form fields alongside the signature,
 * not derived from the request URL or raw body the way Stripe/Twilio work).
 * See https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/#webhooks-security.
 */
export function verifyMailgunSignature(timestamp: string, token: string, signature: string, signingKey: string): boolean {
  const expected = createHmac("sha256", signingKey).update(timestamp + token, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Replay-safe idempotency key derived from the raw payload (§10 outbox dedupe). */
export function payloadIdempotencyKey(prefix: string, rawBody: string): string {
  return `${prefix}:${createHash("sha256").update(rawBody).digest("hex")}`;
}

/**
 * eBay's endpoint-ownership challenge for Marketplace Account Deletion
 * notifications: SHA-256 hex over `challengeCode + verificationToken +
 * endpoint`, in that order. `endpoint` must be byte-for-byte the URL entered
 * in the developer portal. See
 * https://developer.ebay.com/marketplace-account-deletion.
 */
export function ebayChallengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}

export interface EbaySignatureHeader {
  /** Names which of eBay's public keys signed the payload (Notification API `getPublicKey`). */
  kid: string;
  /** Base64 DER ECDSA signature over the raw request body. */
  signature: string;
  digest: "sha1" | "sha256";
}

/** `x-ebay-signature` is base64-encoded JSON: `{ alg, kid, signature, digest }`. Undefined on anything malformed or not ECDSA. */
export function parseEbaySignatureHeader(header: string): EbaySignatureHeader | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { alg, kid, signature, digest } = parsed;
  if (typeof kid !== "string" || kid.length === 0 || typeof signature !== "string" || signature.length === 0) return undefined;
  if (typeof alg !== "string" || alg.toUpperCase() !== "ECDSA") return undefined;
  const digestName = typeof digest === "string" ? digest.toLowerCase().replace("-", "") : "";
  if (digestName !== "sha1" && digestName !== "sha256") return undefined;
  return { kid, signature, digest: digestName };
}

/**
 * Verifies an eBay notification against the public key `getPublicKey`
 * returned for the header's `kid`. eBay returns the key as a PEM with no
 * line breaks, which Node's PEM parser rejects, so the base64 body is read
 * as SPKI DER instead. Returns false rather than throwing on a bad key or
 * signature. Unverified against a live eBay notification in this pass —
 * exercised with a locally generated EC keypair.
 */
export function verifyEbaySignature(rawBody: Buffer, header: EbaySignatureHeader, publicKey: string): boolean {
  try {
    const der = Buffer.from(publicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""), "base64");
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return verifySignature(header.digest, rawBody, key, Buffer.from(header.signature, "base64"));
  } catch {
    return false;
  }
}
