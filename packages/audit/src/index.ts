import type { AuditEvent } from "@opportunity-os/contracts";
import { sha256Hex, canonicalJson } from "./hash";

export { sha256Hex, canonicalJson };

/** Sentinel previous-hash for the first event in a chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Canonical hash of a transaction-proposal command's terms (§14/§22). One
 * source of truth shared by the API and the durable workflow so an approval
 * token minted on either path verifies on the other.
 */
export function hashProposalTerms(terms: { opportunityId: string; grossAmountMinor: number; currency: string }): string {
  return sha256Hex(
    canonicalJson({
      action: "propose_transaction",
      opportunityId: terms.opportunityId,
      grossAmountMinor: terms.grossAmountMinor,
      currency: terms.currency,
    }),
  );
}

/**
 * Canonical hash of a milestone-release command's terms (§14/§22). Mirrors the
 * proposal hash so a release approval token binds this exact milestone + amount.
 */
export function hashReleaseTerms(terms: { milestoneId: string; amountMinor: number; currency: string }): string {
  return sha256Hex(
    canonicalJson({
      action: "release_milestone",
      milestoneId: terms.milestoneId,
      amountMinor: terms.amountMinor,
      currency: terms.currency,
    }),
  );
}

/** An audit event before the chain assigns its linking hashes. */
export type AuditEventDraft = Omit<AuditEvent, "event_hash" | "previous_event_hash">;

/**
 * §21: event_hash = HASH(previous_event_hash + canonical_event_payload).
 * The canonical payload excludes the linking hashes themselves.
 */
export function hashEvent(previousHash: string, draft: AuditEventDraft): string {
  return sha256Hex(previousHash + canonicalJson(draft));
}

/**
 * Append-only, hash-chained audit writer. Construct with the persisted head
 * hash (or GENESIS_HASH for a fresh chain); each append links to the prior
 * event and advances the head.
 */
export class AuditChain {
  private lastHash: string;

  constructor(head: string = GENESIS_HASH) {
    this.lastHash = head;
  }

  get head(): string {
    return this.lastHash;
  }

  append(draft: AuditEventDraft): AuditEvent {
    const previous_event_hash = this.lastHash === GENESIS_HASH ? null : this.lastHash;
    const event_hash = hashEvent(this.lastHash, draft);
    this.lastHash = event_hash;
    return { ...draft, previous_event_hash, event_hash };
  }
}

export interface VerifyResult {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
}

/** Recompute the full chain and detect any tampering (§21, §26 unit tests). */
export function verifyChain(events: readonly AuditEvent[], genesis: string = GENESIS_HASH): VerifyResult {
  let prev = genesis;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const { event_hash: _e, previous_event_hash: _p, ...draft } = event;
    const expectedHash = hashEvent(prev, draft as AuditEventDraft);
    if (expectedHash !== event.event_hash) {
      return { ok: false, brokenAt: i, reason: "event_hash mismatch" };
    }
    const expectedPrev = prev === genesis ? null : prev;
    if ((event.previous_event_hash ?? null) !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: "previous_event_hash mismatch" };
    }
    prev = event.event_hash;
  }
  return { ok: true };
}

/**
 * §21/§940: fold a batch of event hashes into a single root hash that can be
 * anchored to an external immutable system without exposing private data.
 */
export function computeBatchRoot(hashes: readonly string[]): string {
  return sha256Hex(hashes.join(""));
}
