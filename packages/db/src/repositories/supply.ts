import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** A normalized supply candidate ready to persist (§11.1(4)). Money is minor units. */
export interface UpsertSupplyInput {
  sourceId: string;
  externalRef: string;
  title: string;
  description: string;
  category: string | null;
  priceMinor: number | null;
  currency: string;
  quantity: number | null;
  sourceReliability: number;
  /** Listing page at the source; http(s) only (connectors-sdk `safeHttpUrl`). */
  listingUrl?: string | null;
  seller?: { name: string; url?: string; detail?: string } | null;
  /** GeoLocation shape with a display `label`. */
  location?: { label: string; city?: string; region?: string; postalCode?: string; country?: string } | null;
  condition?: string | null;
}

export interface UpsertSupplyResult {
  supplyId: string;
  created: boolean;
}

/**
 * Idempotent supply upsert keyed on (source_id, external_ref). First sight emits
 * supply.discovered.v1; later refreshes update the row in place and stay quiet
 * (the state is already published). `created` uses Postgres xmax to distinguish
 * insert from update within the single upserting statement.
 */
export async function upsertSupply(input: UpsertSupplyInput): Promise<UpsertSupplyResult> {
  const now = new Date().toISOString();
  const price = input.priceMinor === null ? null : { amount: input.priceMinor, currency: input.currency };
  const listingUrl = input.listingUrl ?? null;
  const seller = input.seller ?? null;
  const location = input.location ?? null;
  const condition = input.condition ? { label: input.condition } : {};

  return getDb()
    .transaction()
    .execute(async (tx) => {
      const row = await tx
        .insertInto("supply")
        .values({
          source_id: input.sourceId,
          external_ref: input.externalRef,
          counterparty_id: null,
          title: input.title,
          description: input.description,
          category: input.category,
          price,
          currency: input.currency,
          quantity: input.quantity,
          condition_json: condition,
          location,
          geo_point: null,
          fulfillment_options_json: [],
          availability_status: "available",
          source_evidence_id: null,
          last_verified_at: now,
          listing_url: listingUrl,
          seller_json: seller,
        })
        .onConflict((oc) =>
          oc.columns(["source_id", "external_ref"]).doUpdateSet({
            title: input.title,
            description: input.description,
            category: input.category,
            price,
            currency: input.currency,
            quantity: input.quantity,
            availability_status: "available",
            last_verified_at: now,
            // A source that stops sending a detail (or a caller that has none, like
            // a resolved signal) keeps what an earlier sighting stored.
            listing_url: sql`coalesce(excluded.listing_url, supply.listing_url)`,
            seller_json: sql`coalesce(excluded.seller_json, supply.seller_json)`,
            location: sql`coalesce(excluded.location, supply.location)`,
            condition_json: sql`case when excluded.condition_json = '{}'::jsonb then supply.condition_json else excluded.condition_json end`,
          }),
        )
        .returning(["id", sql<boolean>`(xmax = 0)`.as("created")])
        .executeTakeFirstOrThrow();

      if (row.created) {
        await enqueueEvent(tx, {
          eventName: "supply.discovered.v1",
          aggregateType: "supply",
          aggregateId: row.id,
          idempotencyKey: `supply.discovered:${row.id}`,
          payload: { supplyId: row.id, sourceId: input.sourceId, externalRef: input.externalRef },
        });
      }

      return { supplyId: row.id, created: row.created };
    });
}
