import { sql } from "kysely";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

/** What a user may do with a mission, strongest first. */
export type MissionAccessLevel = "owner" | "editor" | "viewer";
export type MissionShareRole = Exclude<MissionAccessLevel, "owner">;

// User ids are compared as text: the dev auth shim passes x-user-id through
// unvalidated, and a ::uuid cast would turn a malformed header into a 500.

/**
 * The caller's own access to a mission from ownership or a share — `null`
 * when they have neither, `undefined` when the mission doesn't exist. Staff
 * role overrides are the API layer's call, not this function's.
 */
export async function getMissionAccess(missionId: string, userId: string): Promise<MissionAccessLevel | null | undefined> {
  const row = await getDb()
    .selectFrom("missions as m")
    .leftJoin("mission_shares as s", (join) => join.onRef("s.mission_id", "=", "m.id").on(sql<boolean>`s.user_id::text = ${userId}`))
    .select(["m.owner_user_id", "s.role"])
    .where("m.id", "=", missionId)
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.owner_user_id === userId) return "owner";
  return (row.role as MissionShareRole | null) ?? null;
}

export async function listMissionShares(missionId: string) {
  return getDb()
    .selectFrom("mission_shares as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select(["s.id", "s.mission_id", "s.user_id", "s.role", "s.granted_by", "s.created_at", "u.email", "u.display_name"])
    .where("s.mission_id", "=", missionId)
    .orderBy("s.created_at", "asc")
    .execute();
}

export class MissionShareError extends Error {}

export interface ShareMissionInput {
  missionId: string;
  email: string;
  role: MissionShareRole;
  grantedBy: string;
}

/**
 * Grant (or change) a user's access by email. Re-sharing with a different
 * role updates it in place. Emits mission.shared.v1 so the grant shows on the
 * mission timeline — missions have no audit trail of their own.
 */
export async function shareMission(input: ShareMissionInput) {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const mission = await tx.selectFrom("missions").select(["id", "owner_user_id"]).where("id", "=", input.missionId).executeTakeFirst();
      if (!mission) throw new MissionShareError(`Mission ${input.missionId} not found`);
      const user = await tx
        .selectFrom("users")
        .select(["id", "email"])
        .where(sql<boolean>`lower(email) = lower(${input.email})`)
        .executeTakeFirst();
      if (!user) throw new MissionShareError(`No user with email ${input.email}`);
      if (user.id === mission.owner_user_id) throw new MissionShareError("The owner already has full access");

      const share = await tx
        .insertInto("mission_shares")
        .values({ mission_id: input.missionId, user_id: user.id, role: input.role, granted_by: input.grantedBy })
        .onConflict((oc) => oc.columns(["mission_id", "user_id"]).doUpdateSet({ role: input.role, granted_by: input.grantedBy }))
        .returningAll()
        .executeTakeFirstOrThrow();
      await enqueueEvent(tx, {
        eventName: "mission.shared.v1",
        aggregateType: "mission",
        aggregateId: input.missionId,
        idempotencyKey: `mission.shared:${input.missionId}:${user.id}:${input.role}:${Date.now()}`,
        payload: { missionId: input.missionId, userId: user.id, email: user.email, role: input.role, grantedBy: input.grantedBy, summary: `Shared with ${user.email} as ${input.role}` },
      });
      return share;
    });
}

/** Revoke a share. Returns false if there was nothing to revoke. */
export async function unshareMission(missionId: string, userId: string, revokedBy: string): Promise<boolean> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const removed = await tx
        .deleteFrom("mission_shares")
        .where("mission_id", "=", missionId)
        .where("user_id", "=", userId)
        .returning(["role"])
        .executeTakeFirst();
      if (!removed) return false;
      const user = await tx.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
      await enqueueEvent(tx, {
        eventName: "mission.unshared.v1",
        aggregateType: "mission",
        aggregateId: missionId,
        idempotencyKey: `mission.unshared:${missionId}:${userId}:${Date.now()}`,
        payload: { missionId, userId, revokedBy, summary: `Access removed for ${user?.email ?? userId}` },
      });
      return true;
    });
}

/**
 * Missions the user owns or has been shared, newest first, each with the
 * caller's access level plus the counts/recency the archive view needs.
 */
export async function listAccessibleMissions(userId: string) {
  return getDb()
    .selectFrom("missions as m")
    .leftJoin("mission_shares as s", (join) => join.onRef("s.mission_id", "=", "m.id").on(sql<boolean>`s.user_id::text = ${userId}`))
    .selectAll("m")
    .select([
      sql<string>`case when m.owner_user_id::text = ${userId} then 'owner' else s.role end`.as("access"),
      sql<number>`(select count(*)::int from opportunities o join matches mt on mt.id = o.match_id join demands d on d.id = mt.demand_id where d.mission_id = m.id and o.status <> 'rejected')`.as(
        "opportunity_count",
      ),
      sql<string>`greatest(m.updated_at, coalesce((select max(created_at) from outbox where aggregate_type = 'mission' and aggregate_id = m.id::text), m.updated_at))`.as(
        "last_activity_at",
      ),
    ])
    .where((eb) => eb.or([sql<boolean>`m.owner_user_id::text = ${userId}`, eb("s.user_id", "is not", null)]))
    .orderBy("m.created_at", "desc")
    .execute();
}
