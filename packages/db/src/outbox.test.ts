import { describe, it, expect } from "vitest";
import { toEventEnvelope, type OutboxRow } from "./outbox";

describe("outbox -> event envelope", () => {
  it("maps a persisted row to a valid versioned envelope", () => {
    const row: OutboxRow = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      event_name: "mission.created.v1",
      aggregate_type: "mission",
      aggregate_id: "mission-1",
      payload: { missionId: "mission-1", versionId: "v0" },
      idempotency_key: "mission.created:mission-1",
      created_at: "2026-08-31T00:00:00.000Z",
    };
    const env = toEventEnvelope(row);
    expect(env.name).toBe("mission.created.v1");
    expect(env.entity_type).toBe("mission");
    expect(env.entity_id).toBe("mission-1");
    expect(env.actor).toEqual({ type: "system", id: "outbox-relay" });
    expect(env.idempotency_key).toBe("mission.created:mission-1");
    expect(env.payload).toEqual({ missionId: "mission-1", versionId: "v0" });
    expect(env.version).toBe(1);
  });

  it("rejects an unknown event name", () => {
    const row: OutboxRow = {
      id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      event_name: "not.a.real.event",
      aggregate_type: "mission",
      aggregate_id: "m1",
      payload: {},
      idempotency_key: "k1",
      created_at: "2026-08-31T00:00:00.000Z",
    };
    expect(() => toEventEnvelope(row)).toThrow();
  });
});
