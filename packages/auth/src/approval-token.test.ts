import { describe, it, expect } from "vitest";
import { mintApprovalToken, verifyApprovalToken, type ApprovalTokenClaims } from "./approval-token";

const SECRET = "test-secret";

function claims(overrides: Partial<ApprovalTokenClaims> = {}): ApprovalTokenClaims {
  return {
    approvalId: "appr-1",
    action: "propose_transaction",
    entityType: "opportunity",
    entityId: "opp-1",
    payloadHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
}

describe("approval token", () => {
  it("verifies a freshly minted token against its action and payload", () => {
    const token = mintApprovalToken(SECRET, claims());
    const res = verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: "a".repeat(64) });
    expect(res.ok).toBe(true);
    expect(res.claims?.approvalId).toBe("appr-1");
  });

  it("rejects a tampered signature", () => {
    const token = mintApprovalToken(SECRET, claims());
    const tampered = `${token.slice(0, -1)}${token.at(-1) === "A" ? "B" : "A"}`;
    expect(verifyApprovalToken(SECRET, tampered, { action: "propose_transaction", payloadHash: "a".repeat(64) }).reason).toBe("bad_signature");
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintApprovalToken(SECRET, claims());
    expect(verifyApprovalToken("other", token, { action: "propose_transaction", payloadHash: "a".repeat(64) }).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = mintApprovalToken(SECRET, claims({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: "a".repeat(64) }).reason).toBe("expired");
  });

  it("rejects an action or payload mismatch (no cross-command reuse)", () => {
    const token = mintApprovalToken(SECRET, claims());
    expect(verifyApprovalToken(SECRET, token, { action: "release_funds", payloadHash: "a".repeat(64) }).reason).toBe("action_mismatch");
    expect(verifyApprovalToken(SECRET, token, { action: "propose_transaction", payloadHash: "b".repeat(64) }).reason).toBe("payload_mismatch");
  });

  it("rejects a malformed token", () => {
    expect(verifyApprovalToken(SECRET, "not-a-token", { action: "x", payloadHash: "y" }).reason).toBe("malformed");
  });
});
