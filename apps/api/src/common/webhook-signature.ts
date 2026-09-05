import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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

/** Replay-safe idempotency key derived from the raw payload (§10 outbox dedupe). */
export function payloadIdempotencyKey(prefix: string, rawBody: string): string {
  return `${prefix}:${createHash("sha256").update(rawBody).digest("hex")}`;
}
