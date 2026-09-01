import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  createMission,
  enqueueEvent,
  getDb,
  getMission,
  listMissions,
  listOpportunitiesByMission,
  setMissionStatus,
} from "@opportunity-os/db";
import { canTransition, type TransitionMap } from "@opportunity-os/domain";
import type { DemandSpecification, EventName } from "@opportunity-os/contracts";
import type { MissionAction, MissionCreateBody, MissionUpdateBody } from "./mission.dto";
import { parseDemand } from "@opportunity-os/demand";

/** §6.2 mission lifecycle guard. Draft auto-activates on create (see repo). */
const MISSION_TRANSITIONS: TransitionMap<string> = {
  draft: ["active", "archived"],
  active: ["paused", "archived", "completed"],
  paused: ["active", "archived"],
  archived: [],
  completed: [],
};

const ACTION_TARGET: Record<MissionAction, string> = {
  pause: "paused",
  resume: "active",
  archive: "archived",
};

const ACTION_EVENT: Record<MissionAction, EventName> = {
  pause: "mission.paused.v1",
  resume: "mission.updated.v1",
  archive: "mission.archived.v1",
};

@Injectable()
export class MissionService {
  async create(ownerUserId: string, body: MissionCreateBody) {
    // §3.1(3)/§7 — accept a fully-structured spec, or structure the natural-
    // language intent through the demand parser when none is supplied.
    const demandSpec = body.demand_spec ?? (await parseDemand({ text: body.raw_intent })).spec;
    const { missionId } = await createMission({
      ownerUserId,
      title: body.title,
      rawIntent: body.raw_intent,
      autonomyPolicy: body.agent_autonomy_policy,
      demandSpec,
      changedBy: ownerUserId,
    });
    return this.detail(missionId);
  }

  list(ownerUserId: string) {
    return listMissions(ownerUserId);
  }

  /** Mission plus its current version's demand_spec (§16 mission detail). */
  async detail(id: string) {
    const mission = await getMission(id);
    if (!mission) throw new NotFoundException(`Mission ${id} not found`);

    let demand_spec: DemandSpecification | null = null;
    let current_version_number: number | null = null;
    if (mission.current_version_id) {
      const version = await getDb()
        .selectFrom("mission_versions")
        .select(["demand_spec_json", "version_number"])
        .where("id", "=", mission.current_version_id)
        .executeTakeFirst();
      if (version) {
        demand_spec = version.demand_spec_json as DemandSpecification;
        current_version_number = version.version_number;
      }
    }
    return { ...mission, demand_spec, current_version_number };
  }

  async update(id: string, ownerUserId: string, body: MissionUpdateBody) {
    const mission = await getMission(id);
    if (!mission) throw new NotFoundException(`Mission ${id} not found`);
    if (mission.owner_user_id !== ownerUserId) {
      throw new ConflictException("Only the mission owner may edit it");
    }
    await getDb().transaction().execute(async (tx) => {
      await tx
        .updateTable("missions")
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.raw_intent !== undefined ? { raw_intent: body.raw_intent } : {}),
          ...(body.agent_autonomy_policy !== undefined
            ? { agent_autonomy_policy: body.agent_autonomy_policy }
            : {}),
          updated_at: new Date().toISOString(),
        })
        .where("id", "=", id)
        .execute();

      // Editing constraints appends a NEW immutable MissionVersion; prior
      // versions are never mutated (§6.3, §22). current_version_id advances.
      if (body.demand_spec !== undefined) {
        const last = await tx
          .selectFrom("mission_versions")
          .select(({ fn }) => fn.max("version_number").as("max"))
          .where("mission_id", "=", id)
          .executeTakeFirst();
        const nextNumber = Number(last?.max ?? -1) + 1;
        const version = await tx
          .insertInto("mission_versions")
          .values({
            mission_id: id,
            version_number: nextNumber,
            demand_spec_json: body.demand_spec,
            changed_by: ownerUserId,
            change_reason: "edit",
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("missions")
          .set({ current_version_id: version.id })
          .where("id", "=", id)
          .execute();
      }

      await enqueueEvent(tx, {
        eventName: "mission.updated.v1",
        aggregateType: "mission",
        aggregateId: id,
        idempotencyKey: `mission.updated:${id}:${Date.now()}`,
        payload: { missionId: id, fields: Object.keys(body) },
      });
    });
    return this.detail(id);
  }

  async transition(id: string, action: MissionAction) {
    const mission = await getMission(id);
    if (!mission) throw new NotFoundException(`Mission ${id} not found`);

    const target = ACTION_TARGET[action];
    if (!canTransition(MISSION_TRANSITIONS, mission.status, target)) {
      throw new ConflictException(`Cannot ${action} a mission in status '${mission.status}'`);
    }

    await setMissionStatus(id, target);
    await enqueueEvent(getDb(), {
      eventName: ACTION_EVENT[action],
      aggregateType: "mission",
      aggregateId: id,
      idempotencyKey: `mission.${action}:${id}:${Date.now()}`,
      payload: { missionId: id, from: mission.status, to: target },
    });
    return this.detail(id);
  }

  opportunities(missionId: string) {
    return listOpportunitiesByMission(missionId);
  }
}
