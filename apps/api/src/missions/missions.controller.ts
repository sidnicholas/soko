import { Inject } from "@nestjs/common";
import { Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import {
  MissionCreateSchema,
  MissionParseSchema,
  MissionShareSchema,
  MissionSteerSchema,
  MissionUpdateSchema,
  type MissionCreateBody,
  type MissionParseBody,
  type MissionShareBody,
  type MissionSteerBody,
  type MissionUpdateBody,
} from "./mission.dto";
import { MissionService } from "./mission.service";
import { requireMissionAccess } from "./mission-access";
import { parseDemand } from "@opportunity-os/demand";

/** First sentence (or first 60 chars) of the request — an editable default, not a summary. */
function suggestTitle(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? text.trim();
  return first.length <= 60 ? first.replace(/[.!?]$/, "") : `${first.slice(0, 57).trimEnd()}…`;
}

/**
 * Every per-mission route checks the role permission AND the caller's access
 * to that specific mission (owner / editor / viewer via sharing, or a staff
 * override — see mission-access.ts). Mutating responses carry `access` so the
 * UI knows what to offer without a second round trip.
 */
@ApiTags("missions")
@Controller("missions")
export class MissionsController {
  constructor(@Inject(MissionService) private readonly missions: MissionService) {}

  @Post()
  @ApiOperation({ summary: "Create a mission and its immutable v0 version" })
  async create(@CurrentUser() user: Principal, @ZodBody(MissionCreateSchema) body: MissionCreateBody) {
    requirePermission(user, "mission:create");
    return { ...(await this.missions.create(user.userId, body)), access: "owner" as const };
  }

  @Post("parse")
  @ApiOperation({ summary: "Parse a plain-language request into a demand specification for review (creates nothing)" })
  async parse(@CurrentUser() user: Principal, @ZodBody(MissionParseSchema) body: MissionParseBody) {
    requirePermission(user, "mission:create");
    const { spec, source } = await parseDemand({ text: body.text });
    return { demand_spec: spec, source, suggested_title: suggestTitle(body.text) };
  }

  @Get()
  @ApiOperation({ summary: "List missions the caller owns or was shared, with access level and activity" })
  list(@CurrentUser() user: Principal) {
    requirePermission(user, "mission:read");
    return this.missions.list(user.userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Mission detail with current demand specification and the caller's access level" })
  async detail(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:read");
    const access = await requireMissionAccess(user, id, "view");
    return { ...(await this.missions.detail(id)), access };
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit mission title / raw intent / constraints (owner or editor)" })
  async update(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(MissionUpdateSchema) body: MissionUpdateBody,
  ) {
    requirePermission(user, "mission:update");
    const access = await requireMissionAccess(user, id, "edit");
    return { ...(await this.missions.update(id, user.userId, body)), access };
  }

  @Post(":id/discover-durable")
  @ApiOperation({ summary: "Start the durable Temporal discovery workflow for this mission (opt-in; excludes it from the lifecycle-worker sweep)" })
  async discoverDurable(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    const access = await requireMissionAccess(user, id, "edit");
    return { ...(await this.missions.startDurableDiscovery(id)), access };
  }

  @Post(":id/pause")
  @ApiOperation({ summary: "Pause an active mission (owner or editor)" })
  async pause(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    const access = await requireMissionAccess(user, id, "edit");
    return { ...(await this.missions.transition(id, "pause")), access };
  }

  @Post(":id/resume")
  @ApiOperation({ summary: "Resume a paused mission (owner or editor)" })
  async resume(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    const access = await requireMissionAccess(user, id, "edit");
    return { ...(await this.missions.transition(id, "resume")), access };
  }

  @Post(":id/archive")
  @ApiOperation({ summary: "Archive a mission (owner only)" })
  async archive(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:archive");
    const access = await requireMissionAccess(user, id, "own");
    return { ...(await this.missions.transition(id, "archive")), access };
  }

  @Get(":id/opportunities")
  @ApiOperation({ summary: "Opportunities discovered for a mission" })
  async opportunities(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:read");
    await requireMissionAccess(user, id, "view");
    return this.missions.opportunities(id);
  }

  @Get(":id/timeline")
  @ApiOperation({ summary: "Mission history: lifecycle, constraint versions, discoveries, approvals, downstream transactions" })
  async timeline(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:read");
    await requireMissionAccess(user, id, "view");
    return this.missions.timeline(id);
  }

  @Post(":id/steer")
  @ApiOperation({ summary: "Steer the mission's agent: exclude terms from discovery (new constraints version) and set matching opportunities aside" })
  async steer(@CurrentUser() user: Principal, @Param("id") id: string, @ZodBody(MissionSteerSchema) body: MissionSteerBody) {
    requirePermission(user, "mission:update");
    const access = await requireMissionAccess(user, id, "edit");
    const result = await this.missions.steer(id, user.userId, body);
    return { ...result, mission: { ...result.mission, access } };
  }

  @Get(":id/rejected")
  @ApiOperation({ summary: "Opportunities set aside for this mission, with who and why" })
  async rejected(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:read");
    await requireMissionAccess(user, id, "view");
    return this.missions.rejected(id);
  }

  @Get(":id/shares")
  @ApiOperation({ summary: "Who else can access this mission (anyone with access may see it)" })
  async shares(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:read");
    await requireMissionAccess(user, id, "view");
    return this.missions.shares(id);
  }

  @Post(":id/shares")
  @ApiOperation({ summary: "Share the mission with a user by email as viewer or editor (owner only)" })
  async share(@CurrentUser() user: Principal, @Param("id") id: string, @ZodBody(MissionShareSchema) body: MissionShareBody) {
    requirePermission(user, "mission:update");
    await requireMissionAccess(user, id, "own");
    return this.missions.share(id, user.userId, body.email, body.role);
  }

  @Delete(":id/shares/:userId")
  @ApiOperation({ summary: "Revoke a user's access to the mission (owner only)" })
  async unshare(@CurrentUser() user: Principal, @Param("id") id: string, @Param("userId") userId: string) {
    requirePermission(user, "mission:update");
    await requireMissionAccess(user, id, "own");
    return this.missions.unshare(id, userId, user.userId);
  }
}
