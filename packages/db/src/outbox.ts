import type { Kysely, Transaction } from "kysely";
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
