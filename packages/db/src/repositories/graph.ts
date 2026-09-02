import { getDb } from "../pool";

/** Upsert a canonical entity by its deterministic key; returns its id. */
export async function upsertEntity(input: { canonicalKey: string; kind: string; category: string | null; title: string }): Promise<string> {
  const row = await getDb()
    .insertInto("entities")
    .values({ canonical_key: input.canonicalKey, kind: input.kind, category: input.category, title: input.title, attributes_json: {} })
    .onConflict((oc) => oc.column("canonical_key").doUpdateSet({ title: input.title, updated_at: new Date().toISOString() }))
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Bind a supply/demand/signal observation to its canonical entity (idempotent). */
export async function linkEntityMember(entityId: string, memberType: "supply" | "demand" | "signal", memberId: string): Promise<void> {
  await getDb()
    .insertInto("entity_members")
    .values({ entity_id: entityId, member_type: memberType, member_id: memberId })
    .onConflict((oc) => oc.columns(["member_type", "member_id"]).doUpdateSet({ entity_id: entityId }))
    .execute();
}

/** Record a price point for an entity's member; identical prices dedupe (history). */
export async function recordPriceObservation(input: { entityId: string; memberType: string; memberId: string; amountMinor: number; currency: string }): Promise<void> {
  await getDb()
    .insertInto("price_observations")
    .values({ entity_id: input.entityId, member_type: input.memberType, member_id: input.memberId, amount_minor: input.amountMinor, currency: input.currency })
    .onConflict((oc) => oc.columns(["member_type", "member_id", "amount_minor"]).doNothing())
    .execute();
}

export async function upsertGraphEdge(input: {
  srcType: string;
  srcId: string;
  dstType: string;
  dstId: string;
  relation: string;
  weight?: number;
}): Promise<void> {
  await getDb()
    .insertInto("graph_edges")
    .values({ src_type: input.srcType, src_id: input.srcId, dst_type: input.dstType, dst_id: input.dstId, relation: input.relation, weight: input.weight ?? 1, metadata_json: {} })
    .onConflict((oc) => oc.columns(["src_type", "src_id", "dst_type", "dst_id", "relation"]).doNothing())
    .execute();
}

export async function getEntity(id: string) {
  return getDb().selectFrom("entities").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getEntityIdForMember(memberType: string, memberId: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom("entity_members")
    .select(["entity_id"])
    .where("member_type", "=", memberType)
    .where("member_id", "=", memberId)
    .executeTakeFirst();
  return row?.entity_id ?? null;
}

export async function listEntityMembers(entityId: string) {
  return getDb()
    .selectFrom("entity_members")
    .select(["member_type", "member_id"])
    .where("entity_id", "=", entityId)
    .execute();
}

/** Other supply listings for the same entity — comparables (§ market graph). */
export async function listComparableSupply(entityId: string, excludeSupplyId?: string) {
  let q = getDb()
    .selectFrom("entity_members as em")
    .innerJoin("supply as s", "s.id", "em.member_id")
    .where("em.entity_id", "=", entityId)
    .where("em.member_type", "=", "supply")
    .select(["s.id", "s.title", "s.price", "s.currency", "s.availability_status"]);
  if (excludeSupplyId) q = q.where("s.id", "!=", excludeSupplyId);
  return q.execute();
}

export interface EntityPriceStats {
  count: number;
  minMinor: number;
  maxMinor: number;
  medianMinor: number;
  currency: string;
}

/** Price statistics across an entity's observed prices (comparables + history). */
export async function entityPriceStats(entityId: string): Promise<EntityPriceStats | null> {
  const rows = await getDb()
    .selectFrom("price_observations")
    .select(["amount_minor", "currency"])
    .where("entity_id", "=", entityId)
    .orderBy("amount_minor", "asc")
    .execute();
  if (rows.length === 0) return null;
  const amounts = rows.map((r) => r.amount_minor);
  const mid = Math.floor(amounts.length / 2);
  const median = amounts.length % 2 === 0 ? Math.round((amounts[mid - 1]! + amounts[mid]!) / 2) : amounts[mid]!;
  return {
    count: amounts.length,
    minMinor: amounts[0]!,
    maxMinor: amounts[amounts.length - 1]!,
    medianMinor: median,
    currency: rows[0]!.currency,
  };
}
