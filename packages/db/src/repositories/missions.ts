import type { DemandSpecification } from "@opportunity-os/contracts";
import { getDb } from "../pool";
import { enqueueEvent } from "../outbox";

export interface CreateMissionInput {
  ownerUserId: string;
  title: string;
  rawIntent: string;
  autonomyPolicy: string;
  demandSpec: DemandSpecification;
  changedBy: string;
}

export interface CreateMissionResult {
  missionId: string;
  versionId: string;
}

/**
 * Creates a mission plus its immutable v0 MissionVersion and enqueues
 * mission.created.v1 through the outbox — all in one transaction (§6.2/6.3, §10).
 */
export async function createMission(input: CreateMissionInput): Promise<CreateMissionResult> {
  return getDb()
    .transaction()
    .execute(async (tx) => {
      const mission = await tx
        .insertInto("missions")
        .values({
          owner_user_id: input.ownerUserId,
          title: input.title,
          raw_intent: input.rawIntent,
          status: "draft",
          current_version_id: null,
          agent_autonomy_policy: input.autonomyPolicy,
          archived_at: null,
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      const version = await tx
        .insertInto("mission_versions")
        .values({
          mission_id: mission.id,
          version_number: 0,
          demand_spec_json: input.demandSpec,
          changed_by: input.changedBy,
          change_reason: "initial",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await tx
        .updateTable("missions")
        .set({ current_version_id: version.id, status: "active", updated_at: new Date().toISOString() })
        .where("id", "=", mission.id)
        .execute();

      await enqueueEvent(tx, {
        eventName: "mission.created.v1",
        aggregateType: "mission",
        aggregateId: mission.id,
        idempotencyKey: `mission.created:${mission.id}`,
        payload: { missionId: mission.id, versionId: version.id },
      });

      return { missionId: mission.id, versionId: version.id };
    });
}

export async function getMission(id: string) {
  return getDb().selectFrom("missions").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function listMissions(ownerUserId: string) {
  return getDb()
    .selectFrom("missions")
    .selectAll()
    .where("owner_user_id", "=", ownerUserId)
    .orderBy("created_at", "desc")
    .execute();
}

/** Guarded status write; the caller must have validated the transition (§domain). */
export async function setMissionStatus(id: string, status: string): Promise<void> {
  await getDb()
    .updateTable("missions")
    .set({ status, updated_at: new Date().toISOString(), archived_at: status === "archived" ? new Date().toISOString() : null })
    .where("id", "=", id)
    .execute();
}
