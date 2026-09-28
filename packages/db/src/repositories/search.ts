import { sql } from "kysely";
import { getDb } from "../pool";

export interface SearchInput {
  userId: string;
  query: string;
  /** Staff roles can read every mission (see apps/api mission-access.ts); everyone else only owned + shared. */
  allMissions: boolean;
  limit?: number;
}

/** `%term%` for ILIKE with the user's own `%`/`_`/`\` taken literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Phase 4 Search: missions (title/intent) and live opportunities (the
 * listing they matched) across everything the caller can see. Rejected
 * opportunities are left out — they're reachable from their mission.
 */
export async function searchForUser(input: SearchInput) {
  const pattern = likePattern(input.query.trim());
  const limit = input.limit ?? 20;
  const db = getDb();
  const visible = sql<boolean>`(${input.allMissions} or m.owner_user_id::text = ${input.userId} or exists (select 1 from mission_shares s where s.mission_id = m.id and s.user_id::text = ${input.userId}))`;

  const [missions, opportunities] = await Promise.all([
    db
      .selectFrom("missions as m")
      .select(["m.id", "m.title", "m.raw_intent", "m.status", "m.updated_at"])
      .where(visible)
      .where((eb) => eb.or([eb("m.title", "ilike", pattern), eb("m.raw_intent", "ilike", pattern)]))
      .orderBy("m.updated_at", "desc")
      .limit(limit)
      .execute(),
    db
      .selectFrom("opportunities as o")
      .innerJoin("matches as mt", "mt.id", "o.match_id")
      .innerJoin("demands as d", "d.id", "mt.demand_id")
      .innerJoin("missions as m", "m.id", "d.mission_id")
      .innerJoin("supply as s", "s.id", "mt.supply_id")
      .select(["o.id", "o.status", "o.overall_score", "s.title as supply_title", "m.id as mission_id", "m.title as mission_title"])
      .where(visible)
      .where("o.status", "<>", "rejected")
      .where((eb) => eb.or([eb("s.title", "ilike", pattern), eb("s.description", "ilike", pattern)]))
      .orderBy("o.overall_score", "desc")
      .limit(limit)
      .execute(),
  ]);
  return { missions, opportunities };
}
