import { getDb } from "../pool";

/** Operator dashboard feed: highest-ranked opportunities first (§3.1(11), §15.2). */
export async function listOpportunitiesForOperator(limit = 50) {
  return getDb()
    .selectFrom("opportunities")
    .selectAll()
    .where("status", "in", ["qualified", "awaiting_approval", "approved"])
    .orderBy("overall_score", "desc")
    .limit(limit)
    .execute();
}

export async function listOpportunitiesByMission(missionId: string) {
  return getDb()
    .selectFrom("opportunities as o")
    .innerJoin("matches as m", "m.id", "o.match_id")
    .innerJoin("demands as d", "d.id", "m.demand_id")
    .where("d.mission_id", "=", missionId)
    .orderBy("o.overall_score", "desc")
    .selectAll("o")
    .execute();
}

export async function getOpportunity(id: string) {
  return getDb().selectFrom("opportunities").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function setOpportunityStatus(id: string, status: string): Promise<void> {
  await getDb().updateTable("opportunities").set({ status }).where("id", "=", id).execute();
}
