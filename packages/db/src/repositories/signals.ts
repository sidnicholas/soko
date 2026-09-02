import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";
import { upsertSupply } from "./supply";
import { upsertSourceDemand } from "./demands";

/** A raw multi-channel signal before it becomes Supply/Demand. */
export interface CreateSignalInput {
  channel: string;
  kind: "supply" | "demand";
  sourceId: string;
  externalRef: string | null;
  title: string | null;
  description: string;
  category: string | null;
  priceMinor: number | null;
  currency: string;
  contentHash: string;
  sourceReliability: number;
  raw?: Record<string, unknown>;
}

export async function createSignal(input: CreateSignalInput): Promise<{ signalId: string; created: boolean }> {
  const price = input.priceMinor === null ? null : { amount: input.priceMinor, currency: input.currency };
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("signals")
        .values({
          channel: input.channel,
          kind: input.kind,
          source_id: input.sourceId,
          external_ref: input.externalRef,
          title: input.title,
          description: input.description,
          category: input.category,
          price,
          geo_point: null,
          raw_json: JSON.stringify(input.raw ?? {}),
          content_hash: input.contentHash,
          source_reliability: input.sourceReliability,
          status: "captured",
          resolved_entity_type: null,
          resolved_entity_id: null,
        })
        .onConflict((oc) =>
          oc.columns(["source_id", "external_ref"]).doUpdateSet({
            title: input.title,
            description: input.description,
            category: input.category,
            price,
            content_hash: input.contentHash,
            source_reliability: input.sourceReliability,
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();

      if (row.created) {
        await enqueueEvent(tx, {
          eventName: "signal.captured.v1",
          aggregateType: "signal",
          aggregateId: row.id,
          idempotencyKey: `signal.captured:${row.id}`,
          payload: { signalId: row.id, channel: input.channel, kind: input.kind },
        });
      }
      return { signalId: row.id, created: row.created };
    });
}

function readMoneyMinor(value: unknown): { amountMinor: number; currency: string } | null {
  if (value && typeof value === "object" && "amount" in value && typeof value.amount === "number") {
    const currency = "currency" in value && typeof value.currency === "string" ? value.currency : "USD";
    return { amountMinor: value.amount, currency };
  }
  return null;
}

/**
 * Project a captured signal into a Supply or Demand row (entering the existing
 * match/opportunity machinery), mark it resolved, and emit signal.resolved.v1.
 * Idempotent: a re-resolve returns the already-linked entity.
 */
export async function resolveSignal(signalId: string): Promise<{ entityType: string; entityId: string } | null> {
  const signal = await getDb().selectFrom("signals").selectAll().where("id", "=", signalId).executeTakeFirst();
  if (!signal) return null;
  if (signal.status === "resolved" && signal.resolved_entity_type && signal.resolved_entity_id) {
    return { entityType: signal.resolved_entity_type, entityId: signal.resolved_entity_id };
  }

  const money = readMoneyMinor(signal.price);
  const currency = money?.currency ?? "USD";
  const externalRef = signal.external_ref ?? signal.id;

  let entityType: string;
  let entityId: string;
  if (signal.kind === "supply") {
    const { supplyId } = await upsertSupply({
      sourceId: signal.source_id,
      externalRef,
      title: signal.title ?? "untitled",
      description: signal.description,
      category: signal.category,
      priceMinor: money?.amountMinor ?? null,
      currency,
      quantity: null,
      sourceReliability: signal.source_reliability,
    });
    entityType = "supply";
    entityId = supplyId;
  } else {
    const { demandId } = await upsertSourceDemand({
      sourceId: signal.source_id,
      externalRef,
      description: signal.description,
      category: signal.category,
      targetPriceMinor: money?.amountMinor ?? null,
      currency,
    });
    entityType = "demand";
    entityId = demandId;
  }

  await getDb()
    .transaction()
    .execute(async (tx) => {
      await tx
        .updateTable("signals")
        .set({ status: "resolved", resolved_entity_type: entityType, resolved_entity_id: entityId })
        .where("id", "=", signalId)
        .execute();
      await enqueueEvent(tx, {
        eventName: "signal.resolved.v1",
        aggregateType: "signal",
        aggregateId: signalId,
        idempotencyKey: `signal.resolved:${signalId}`,
        payload: { signalId, entityType, entityId },
      });
    });

  return { entityType, entityId };
}
