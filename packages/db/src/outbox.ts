import type { Kysely, Transaction } from "kysely";
import { EventEnvelope } from "@opportunity-os/contracts";
import type { EventName } from "@opportunity-os/contracts";
import type { Database } from "./schema";

export interface OutboxWrite {
  eventName: EventName;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/**
 * §10/§550 — enqueue a domain event in the SAME transaction as the state
 * change that produced it. A relay worker later publishes unpublished rows,
 * guaranteeing DB state and events never diverge.
 */
export async function enqueueEvent(
  tx: Transaction<Database> | Kysely<Database>,
  write: OutboxWrite,
): Promise<void> {
  await tx
    .insertInto("outbox")
    .values({
      event_name: write.eventName,
      aggregate_type: write.aggregateType,
      aggregate_id: write.aggregateId,
      idempotency_key: write.idempotencyKey,
      payload: write.payload,
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}

/** Raw outbox row as read by the relay. */
export interface OutboxRow {
  id: string;
  event_name: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  idempotency_key: string;
  created_at: string;
}

/** Fetch the oldest unpublished events for the relay to publish (§10/§550). */
export async function claimUnpublished(db: Kysely<Database>, limit = 100): Promise<OutboxRow[]> {
  const rows = await db
    .selectFrom("outbox")
    .select(["id", "event_name", "aggregate_type", "aggregate_id", "payload", "idempotency_key", "created_at"])
    .where("published", "=", false)
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, created_at: String(r.created_at) }));
}

/** Mark events published once the publisher has durably accepted them. */
export async function markPublished(db: Kysely<Database>, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable("outbox")
    .set({ published: true, published_at: new Date().toISOString() })
    .where("id", "in", ids as string[])
    .execute();
}

/** Map a persisted outbox row to a versioned, idempotent event envelope (§10). */
export function toEventEnvelope(row: OutboxRow): EventEnvelope {
  return EventEnvelope.parse({
    id: row.id,
    name: row.event_name,
    version: 1,
    occurred_at: new Date(row.created_at).toISOString(),
    actor: { type: "system", id: "outbox-relay" },
    entity_type: row.aggregate_type,
    entity_id: row.aggregate_id,
    correlation_id: null,
    mission_id: null,
    idempotency_key: row.idempotency_key,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  });
}
