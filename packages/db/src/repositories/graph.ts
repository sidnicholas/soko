import { sql } from "kysely";
import { getConfig } from "@opportunity-os/config";
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

/** True when the pgvector backend is active (vector column + <=> queries). */
export function isPgvectorBackend(): boolean {
  return getConfig().llm.embeddingBackend === "pgvector";
}

/**
 * Store an entity's embedding. Always jsonb (portable); on the pgvector backend
 * also writes the `vector` column so <=> nearest-neighbour works (ADR-026).
 */
export async function setEntityEmbedding(entityId: string, vector: number[]): Promise<void> {
  if (isPgvectorBackend()) {
    const literal = `[${vector.join(",")}]`;
    await sql`update entities set embedding = ${JSON.stringify(vector)}::jsonb, embedding_vec = ${literal}::vector where id = ${entityId}`.execute(getDb());
    return;
  }
  await getDb().updateTable("entities").set({ embedding: JSON.stringify(vector) }).where("id", "=", entityId).execute();
}

/** pgvector nearest neighbours in the same category (cosine via `<=>`), ADR-026. */
export async function nearestEntitiesByVector(entityId: string, limit = 10, minSim = 0.6): Promise<{ id: string; sim: number }[]> {
  const result = await sql<{ id: string; sim: number }>`
    select e2.id, 1 - (e1.embedding_vec <=> e2.embedding_vec) as sim
    from entities e1
    join entities e2 on e2.category is not distinct from e1.category and e2.id <> e1.id
    where e1.id = ${entityId} and e1.embedding_vec is not null and e2.embedding_vec is not null
    order by e1.embedding_vec <=> e2.embedding_vec asc
    limit ${limit}
  `.execute(getDb());
  return result.rows.filter((r) => Number(r.sim) >= minSim).map((r) => ({ id: r.id, sim: Number(r.sim) }));
}

/**
 * Build SUBSTITUTE_OF edges entirely in SQL: top-K nearest neighbours per
 * entity via a LATERAL join on `<=>` (pgvector only). Returns rows affected.
 */
export async function buildSubstituteEdgesSql(minSim = 0.6, k = 10): Promise<number> {
  const res = await sql<{ src_id: string }>`
    insert into graph_edges (src_type, src_id, dst_type, dst_id, relation, weight)
    select 'entity', e.id, 'entity', nn.id, 'SUBSTITUTE_OF', nn.sim
    from entities e
    cross join lateral (
      select e2.id, 1 - (e.embedding_vec <=> e2.embedding_vec) as sim
      from entities e2
      where e2.id <> e.id and e2.category is not distinct from e.category and e2.embedding_vec is not null
      order by e.embedding_vec <=> e2.embedding_vec asc
      limit ${k}
    ) nn
    where e.embedding_vec is not null and nn.sim >= ${minSim}
    on conflict (src_type, src_id, dst_type, dst_id, relation) do update set weight = excluded.weight
    returning src_id
  `.execute(getDb());
  return res.rows.length;
}

/**
 * Cross-entity arbitrage in SQL (vector + price join): for each SUBSTITUTE_OF
 * edge, if the destination substitute's cheapest price exceeds the source's by
 * >= minSpread, emit an ARBITRAGE edge src->dst (buy cheap, sell into the dearer
 * substitute market), weight = spread. Backend-agnostic. Returns rows affected.
 */
export async function buildArbitrageEdgesSql(minSpread = 0.2): Promise<number> {
  const res = await sql<{ src_id: string }>`
    with prices as (
      select entity_id, min(amount_minor) as min_price, max(currency) as currency
      from price_observations group by entity_id
    )
    insert into graph_edges (src_type, src_id, dst_type, dst_id, relation, weight, metadata_json)
    select 'entity', se.src_id, 'entity', se.dst_id, 'ARBITRAGE',
           (dear.min_price - cheap.min_price)::float8 / dear.min_price,
           jsonb_build_object('buyMinor', cheap.min_price, 'sellRefMinor', dear.min_price, 'currency', cheap.currency)
    from graph_edges se
    join prices cheap on cheap.entity_id = se.src_id
    join prices dear on dear.entity_id = se.dst_id
    where se.relation = 'SUBSTITUTE_OF' and se.src_type = 'entity'
      and dear.min_price > 0
      and (dear.min_price - cheap.min_price)::float8 / dear.min_price >= ${minSpread}
    on conflict (src_type, src_id, dst_type, dst_id, relation)
      do update set weight = excluded.weight, metadata_json = excluded.metadata_json
    returning src_id
  `.execute(getDb());
  return res.rows.length;
}

export interface EntityEmbeddingRow {
  id: string;
  category: string | null;
  embedding: number[];
}

/** All entities with an embedding (for similarity/substitute detection). */
export async function listEntityEmbeddings(): Promise<EntityEmbeddingRow[]> {
  const rows = await getDb()
    .selectFrom("entities")
    .select(["id", "category", "embedding"])
    .where("embedding", "is not", null)
    .execute();
  return rows.map((r) => ({ id: r.id, category: r.category, embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : [] }));
}

/** Seller count + total available quantity for an entity (bundle readiness). */
export async function entitySupplyAgg(entityId: string): Promise<{ sellerCount: number; totalQuantity: number }> {
  const row = await getDb()
    .selectFrom("entity_members as em")
    .innerJoin("supply as s", "s.id", "em.member_id")
    .where("em.entity_id", "=", entityId)
    .where("em.member_type", "=", "supply")
    .where("s.availability_status", "=", "available")
    .select((eb) => [eb.fn.count<string>("s.id").as("sellers"), eb.fn.sum<string>("s.quantity").as("qty")])
    .executeTakeFirst();
  return { sellerCount: Number(row?.sellers ?? 0), totalQuantity: Number(row?.qty ?? 0) };
}

/** All graph edges originating from a node (for the intelligence surface). */
export async function listEdgesFrom(srcType: string, srcId: string) {
  return getDb()
    .selectFrom("graph_edges")
    .select(["dst_type", "dst_id", "relation", "weight"])
    .where("src_type", "=", srcType)
    .where("src_id", "=", srcId)
    .execute();
}
