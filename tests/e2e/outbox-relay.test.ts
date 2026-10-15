import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@opportunity-os/contracts";
import { closeDb, enqueueEvent, getDb, relayOutboxBatch } from "@opportunity-os/db";

/**
 * PRD v2 P0: events replay without duplication. Two relays running at once
 * must not publish the same outbox row twice, and a publish failure must not
 * lose or re-mark rows the publisher already accepted.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = randomUUID().slice(0, 8);

async function enqueue(n: number, tag: string): Promise<string[]> {
  const keys = Array.from({ length: n }, (_, i) => `relay-${tag}-${RUN}-${i}`);
  for (const key of keys) {
    await enqueueEvent(getDb(), { eventName: "signal.captured.v1", aggregateType: "signal", aggregateId: randomUUID(), idempotencyKey: key, payload: { key } });
  }
  return keys;
}

/** Drains the outbox with `relays` concurrent relays; returns how often each key was published. */
async function drain(relays: number): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  const publish = async (e: EventEnvelope) => {
    await new Promise((r) => setTimeout(r, 5)); // hold the batch's locks long enough to overlap
    seen.set(e.idempotency_key, (seen.get(e.idempotency_key) ?? 0) + 1);
  };
  for (;;) {
    const counts = await Promise.all(Array.from({ length: relays }, () => relayOutboxBatch(getDb(), publish, 10)));
    if (counts.every((c) => c === 0)) return seen;
  }
}

describe.skipIf(!HAS_DB)("outbox relay (live postgres)", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("publishes each event exactly once with concurrent relays", async () => {
    const keys = await enqueue(25, "concurrent");
    const seen = await drain(3);
    for (const key of keys) expect(seen.get(key)).toBe(1);
  });

  it("keeps rows published before a failure and retries the rest", async () => {
    await drain(1); // start from an empty queue
    const keys = await enqueue(3, "failure");
    let calls = 0;
    const flaky = async (e: EventEnvelope) => {
      calls++;
      if (e.idempotency_key === keys[1]) throw new Error("broker down");
    };
    await expect(relayOutboxBatch(getDb(), flaky, 10)).rejects.toThrow("broker down");
    expect(calls).toBe(2);

    const rows = await getDb().selectFrom("outbox").select(["idempotency_key", "published"]).where("idempotency_key", "in", keys).execute();
    const published = Object.fromEntries(rows.map((r) => [r.idempotency_key, r.published]));
    expect(published).toEqual({ [keys[0]!]: true, [keys[1]!]: false, [keys[2]!]: false });

    const seen = await drain(1);
    expect(seen.get(keys[0]!)).toBeUndefined();
    expect(seen.get(keys[1]!)).toBe(1);
    expect(seen.get(keys[2]!)).toBe(1);
  });
});
