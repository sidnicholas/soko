import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { getMissionAccess, type MissionAccessLevel } from "@opportunity-os/db";
import type { Principal } from "../common/current-user";

/** What the caller needs to do: read it, change it, or manage who else can. */
export type MissionNeed = "view" | "edit" | "own";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RANK: Record<MissionAccessLevel, number> = { viewer: 0, editor: 1, owner: 2 };
const NEED_RANK: Record<MissionNeed, number> = { view: 0, edit: 1, own: 2 };

/**
 * Staff roles' standing access to missions they neither own nor were shared:
 * admins act as owner; operators/reviewers (the console) and service/agent
 * principals can read everything but change only what they were granted.
 */
function staffAccess(principal: Principal): MissionAccessLevel | null {
  if (principal.role === "admin") return "owner";
  if (principal.role === "operator" || principal.role === "reviewer" || principal.role === "service" || principal.role === "agent") return "viewer";
  return null;
}

function strongest(a: MissionAccessLevel | null, b: MissionAccessLevel | null): MissionAccessLevel | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Mission-level authorization (Phase 4 sharing), layered on top of the
 * role permission check (`requirePermission`). 404 for a missing mission, and
 * also for one the caller has no access to at all — not 403 — so mission ids
 * can't be probed for existence.
 */
export async function requireMissionAccess(principal: Principal, missionId: string, need: MissionNeed): Promise<MissionAccessLevel> {
  if (!UUID.test(missionId)) throw new NotFoundException(`Mission ${missionId} not found`);
  const own = await getMissionAccess(missionId, principal.userId);
  if (own === undefined) throw new NotFoundException(`Mission ${missionId} not found`);
  const level = strongest(own, staffAccess(principal));
  if (!level) throw new NotFoundException(`Mission ${missionId} not found`);
  if (RANK[level] < NEED_RANK[need]) {
    throw new ForbiddenException(`Mission ${missionId}: ${level} access cannot ${need === "own" ? "manage sharing or archive" : "make changes"}`);
  }
  return level;
}
