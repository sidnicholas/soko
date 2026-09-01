import { sha256Hex, canonicalJson } from "@opportunity-os/audit";

/**
 * Deterministic hash of a proposed action's payload (§14/§22). The same payload
 * hashed at approval-request time and at execution time must match, so the
 * approval token can only authorize the exact command a human saw.
 */
export function hashActionPayload(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(payload));
}
