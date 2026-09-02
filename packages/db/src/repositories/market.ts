import { getDb } from "../pool";

/** Open demands (mission or signal-sourced) eligible for cross-source synthesis. */
export async function listOpenDemands(limit = 100) {
  return getDb()
    .selectFrom("demands")
    .select(["id", "description", "category", "target_price", "max_budget", "currency", "urgency_score"])
    .where("availability_status", "in", ["active", "unknown"])
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

/** Available supply (any source) eligible for cross-source synthesis. */
export async function listAvailableSupply(limit = 500) {
  return getDb()
    .selectFrom("supply")
    .select(["id", "title", "description", "category", "price", "currency"])
    .where("availability_status", "=", "available")
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}
