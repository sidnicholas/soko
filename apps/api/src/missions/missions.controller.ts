import { Inject } from "@nestjs/common";
import { Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { MissionCreateSchema, MissionUpdateSchema, type MissionCreateBody, type MissionUpdateBody } from "./mission.dto";
import { MissionService } from "./mission.service";

@ApiTags("missions")
@Controller("missions")
export class MissionsController {
  constructor(@Inject(MissionService) private readonly missions: MissionService) {}

  @Post()
  @ApiOperation({ summary: "Create a mission and its immutable v0 version" })
  create(@CurrentUser() user: Principal, @ZodBody(MissionCreateSchema) body: MissionCreateBody) {
    requirePermission(user, "mission:create");
    return this.missions.create(user.userId, body);
  }

  @Get()
  @ApiOperation({ summary: "List the caller's missions" })
  list(@CurrentUser() user: Principal) {
    requirePermission(user, "mission:read");
    return this.missions.list(user.userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Mission detail with current demand specification" })
  detail(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:read");
    return this.missions.detail(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit mission title / raw intent" })
  update(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(MissionUpdateSchema) body: MissionUpdateBody,
  ) {
    requirePermission(user, "mission:update");
    return this.missions.update(id, user.userId, body);
  }

  @Post(":id/discover-durable")
  @ApiOperation({ summary: "Start the durable Temporal discovery workflow for this mission (opt-in; excludes it from the lifecycle-worker sweep)" })
  discoverDurable(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    return this.missions.startDurableDiscovery(id);
  }

  @Post(":id/pause")
  @ApiOperation({ summary: "Pause an active mission" })
  pause(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    return this.missions.transition(id, "pause");
  }

  @Post(":id/resume")
  @ApiOperation({ summary: "Resume a paused mission" })
  resume(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:update");
    return this.missions.transition(id, "resume");
  }

  @Post(":id/archive")
  @ApiOperation({ summary: "Archive a mission" })
  archive(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "mission:archive");
    return this.missions.transition(id, "archive");
  }

  @Get(":id/opportunities")
  @ApiOperation({ summary: "Opportunities discovered for a mission" })
  opportunities(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:read");
    return this.missions.opportunities(id);
  }
}
