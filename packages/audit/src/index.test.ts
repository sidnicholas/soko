import { describe, it, expect } from "vitest";
import type { AuditEvent } from "@opportunity-os/contracts";
import { AuditChain, verifyChain, GENESIS_HASH, canonicalJson, computeBatchRoot } from "./index";
import type { AuditEventDraft } from "./index";

function draft(n: number): AuditEventDraft {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    actor_type: "agent",
    actor_id: "collector",
    action: `test.action.${n}`,
    entity_type: "opportunity",
    entity_id: `opp-${n}`,
    input_hash: null,
    output_hash: null,
    policy_version: "v1",
    model_provider: null,
    model: null,
    model_version: null,
    confidence: 0.9,
    created_at: "2026-08-31T00:00:00.000Z",
  };
}

describe("audit hash chain", () => {
  it("links events and verifies a clean chain", () => {
    const chain = new AuditChain();
    const events: AuditEvent[] = [draft(1), draft(2), draft(3)].map((d) => chain.append(d));

    expect(events[0]!.previous_event_hash).toBeNull();
    expect(events[1]!.previous_event_hash).toBe(events[0]!.event_hash);
    expect(events[2]!.previous_event_hash).toBe(events[1]!.event_hash);
    expect(chain.head).toBe(events[2]!.event_hash);
    expect(verifyChain(events)).toEqual({ ok: true });
  });

  it("detects a tampered payload", () => {
    const chain = new AuditChain();
    const events: AuditEvent[] = [draft(1), draft(2), draft(3)].map((d) => chain.append(d));
    const tampered = events.map((e, i) => (i === 1 ? { ...e, action: "hacked" } : e));

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("detects a broken link even when payloads are individually consistent", () => {
    const chain = new AuditChain();
    const events: AuditEvent[] = [draft(1), draft(2), draft(3)].map((d) => chain.append(d));
    const reordered = [events[0]!, events[2]!, events[1]!];

    expect(verifyChain(reordered).ok).toBe(false);
  });

  it("canonical json is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("batch root is deterministic", () => {
    const hashes = ["a".repeat(64), "b".repeat(64)];
    expect(computeBatchRoot(hashes)).toBe(computeBatchRoot(hashes));
    expect(GENESIS_HASH).toHaveLength(64);
  });
});
