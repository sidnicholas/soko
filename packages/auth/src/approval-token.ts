import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * §14/§22 — a signed, expiring capability minted only when a human approves a
 * proposed action. It binds the exact action and payload hash, so a token for
 * one approved command can never authorize a different or mutated one ("a
 * settlement executor requires an approved command with matching payload hash").
 * Stateless HMAC: no DB lookup needed to verify authenticity, though callers
 * SHOULD still confirm the approval row is in an approved state.
 */
export interface ApprovalTokenClaims {
  approvalId: string;
  action: string;
  entityType: string;
  entityId: string;
  payloadHash: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function mintApprovalToken(secret: string, claims: ApprovalTokenClaims): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export interface VerifyApprovalInput {
  action: string;
  payloadHash: string;
  now?: Date;
}

export interface VerifyApprovalResult {
  ok: boolean;
  reason?: string;
  claims?: ApprovalTokenClaims;
}

/**
 * Verify signature (constant-time), expiry, and that the token's action and
 * payload hash match the action being attempted. Never throws.
 */
export function verifyApprovalToken(secret: string, token: string, expected: VerifyApprovalInput): VerifyApprovalResult {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expectedSig = Buffer.from(sign(secret, body));
  if (provided.length !== expectedSig.length || !timingSafeEqual(provided, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: ApprovalTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ApprovalTokenClaims;
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  const now = expected.now ?? new Date();
  if (Number.isNaN(Date.parse(claims.expiresAt)) || Date.parse(claims.expiresAt) < now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (claims.action !== expected.action) return { ok: false, reason: "action_mismatch" };
  if (claims.payloadHash !== expected.payloadHash) return { ok: false, reason: "payload_mismatch" };
  return { ok: true, claims };
}
