import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  createMission,
  enqueueEvent,
  getDb,
  getMission,
  listAccessibleMissions,
  listRejectedOpportunities,
  steerMission,
  listMissionShares,
  MissionShareError,
  shareMission,
  unshareMission,
  listOpportunitiesByMission,
  missionTimeline,
  setMissionStatus,
  setMissionTemporalWorkflowId,
} from "@opportunity-os/db";
import { canTransition, type TransitionMap } from "@opportunity-os/domain";
import { projectMissionDemand } from "@opportunity-os/discovery";
import { getConfig } from "@opportunity-os/config";
import type { DemandSpecification, EventName } from "@opportunity-os/contracts";
import type { MissionAction, MissionCreateBody, MissionSteerBody, MissionUpdateBody } from "./mission.dto";
import { parseDemand } from "@opportunity-os/demand";
import { startMissionDiscovery, signalMissionDemand, signalMissionWorkflow } from "./temporal";

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

  /** Missions the caller owns or was shared, with their access level (Phase 4 sharing). */
  list(userId: string) {
    return listAccessibleMissions(userId);
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

  async update(id: string, editorUserId: string, body: MissionUpdateBody) {
    // Owner-or-editor is enforced by the controller (requireMissionAccess).
    const mission = await getMission(id);
    if (!mission) throw new NotFoundException(`Mission ${id} not found`);
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
            changed_by: editorUserId,
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
    if (body.demand_spec !== undefined && mission.temporal_workflow_id) {
      await signalMissionDemand(mission.temporal_workflow_id, projectMissionDemand(body.demand_spec));
    }
    return this.detail(id);
  }

  /**
   * Phase 4 user→agent steering: exclusions become a new constraints version
   * that every future discovery cycle honors (including a running durable
   * workflow, which is re-signaled), and matching open opportunities are set
   * aside now with the reason.
   */
  async steer(id: string, actorId: string, body: MissionSteerBody) {
    let result;
    try {
      result = await steerMission({ missionId: id, excludeTerms: body.exclude_terms, note: body.note ?? null, actorId });
    } catch (err) {
      if (err instanceof Error && /no demand specification/.test(err.message)) throw new ConflictException(err.message);
      throw err;
    }
    const detail = await this.detail(id);
    if (detail.temporal_workflow_id && detail.demand_spec) {
      await signalMissionDemand(detail.temporal_workflow_id, projectMissionDemand(detail.demand_spec));
    }
    return { mission: detail, steering: result };
  }

  rejected(missionId: string) {
    return listRejectedOpportunities(missionId);
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
    if (mission.temporal_workflow_id) {
      await signalMissionWorkflow(mission.temporal_workflow_id, action);
    }
    return this.detail(id);
  }

  /**
   * Start the durable `missionDiscoveryWorkflow` for this mission (ST-13-style
   * wiring): once started, `listActiveMissionsForDiscovery` excludes it from
   * worker-lifecycle's own sweep so the two schedulers never overlap. Opt-in —
   * a mission with no durable workflow keeps working exactly as before.
   */
  async startDurableDiscovery(id: string) {
    const mission = await this.detail(id);
    if (mission.status !== "active") throw new ConflictException(`Mission ${id} is not active`);
    if (mission.temporal_workflow_id) throw new ConflictException(`Mission ${id} already has a running discovery workflow`);
    if (!mission.demand_spec) throw new ConflictException(`Mission ${id} has no demand spec to drive discovery`);

    const workflowId = await startMissionDiscovery({
      missionId: id,
      demand: projectMissionDemand(mission.demand_spec),
      refreshIntervalMinutes: getConfig().policy.missionRefreshIntervalMinutes,
    });
    if (!workflowId) throw new ConflictException("Could not start the discovery workflow (Temporal unreachable)");
    await setMissionTemporalWorkflowId(id, workflowId);
    return this.detail(id);
  }

  opportunities(missionId: string) {
    return listOpportunitiesByMission(missionId);
  }

  shares(missionId: string) {
    return listMissionShares(missionId);
  }

  async share(missionId: string, grantedBy: string, email: string, role: "viewer" | "editor") {
    try {
      await shareMission({ missionId, email, role, grantedBy });
    } catch (err) {
      if (err instanceof MissionShareError) throw new BadRequestException(err.message);
      throw err;
    }
    return listMissionShares(missionId);
  }

  async unshare(missionId: string, userId: string, revokedBy: string) {
    if (!(await unshareMission(missionId, userId, revokedBy))) {
      throw new NotFoundException(`Mission ${missionId} is not shared with user ${userId}`);
    }
    return listMissionShares(missionId);
  }

  /** Merged mission history: lifecycle, constraint versions, discoveries, approvals, and downstream transactions (Phase 4). */
  async timeline(missionId: string) {
    const entries = await missionTimeline(missionId);
    if (!entries) throw new NotFoundException(`Mission ${missionId} not found`);
    return entries;
  }
}
