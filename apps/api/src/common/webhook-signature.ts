import { createHash, createHmac, timingSafeEqual } from "node:crypto";

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
