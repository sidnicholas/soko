import { Inject } from "@nestjs/common";
import { ConflictException, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { getOpportunityMissionId, rejectOpportunity } from "@opportunity-os/db";
import { InvalidTransitionError } from "@opportunity-os/domain";
import { requireMissionAccess } from "../missions/mission-access";
import { OpportunityRejectSchema, type OpportunityRejectBody } from "../missions/mission.dto";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import {
  RecordOutcomeSchema,
  RequestApprovalSchema,
  type RecordOutcomeBody,
  type RequestApprovalBody,
} from "./opportunity.dto";
import { OpportunityService } from "./opportunity.service";

@ApiTags("opportunities")
@Controller("opportunities")
export class OpportunitiesController {
  constructor(@Inject(OpportunityService) private readonly opportunities: OpportunityService) {}

  @Get()
  @ApiOperation({ summary: "Operator dashboard feed of ranked opportunities" })
  list(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:read");
    return this.opportunities.list();
  }

  @Get(":id")
  @ApiOperation({ summary: "Opportunity detail with economics and scores" })
  get(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:read");
    return this.opportunities.get(id);
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Set an opportunity aside with a reason (mission owner/editor; operators for graph deals). Discovery won't resurrect it." })
  async reject(@CurrentUser() user: Principal, @Param("id") id: string, @ZodBody(OpportunityRejectSchema) body: OpportunityRejectBody) {
    const missionId = await getOpportunityMissionId(id);
    if (missionId === undefined) throw new NotFoundException(`Opportunity ${id} not found`);
    if (missionId) {
      requirePermission(user, "mission:update");
      await requireMissionAccess(user, missionId, "edit");
    } else {
      // Graph-derived deals belong to no mission — an operator decision.
      requirePermission(user, "opportunity:reverify");
    }
    try {
      await rejectOpportunity({ opportunityId: id, reason: body.reason, actorId: user.userId });
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw new ConflictException(err.message);
      throw err;
    }
    return this.opportunities.get(id);
  }

  @Post(":id/reverify")
  @ApiOperation({ summary: "Re-check availability and refresh verification" })
  reverify(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.opportunities.reverify(id);
  }

  @Post(":id/prepare-negotiation")
  @ApiOperation({ summary: "Prepare a negotiation draft (no autonomous sending)" })
  prepareNegotiation(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "negotiation:prepare");
    return this.opportunities.prepareNegotiation(id);
  }

  @Post(":id/request-approval")
  @ApiOperation({ summary: "Request human approval to propose a transaction" })
  requestApproval(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(RequestApprovalSchema) body: RequestApprovalBody,
  ) {
    requirePermission(user, "approval:create");
    return this.opportunities.requestApproval(id, user, body);
  }

  @Post(":id/execute-durable")
  @ApiOperation({ summary: "Durable variant of request-approval: runs the Temporal opportunityExecutionWorkflow (approval + execution survive process restarts)" })
  executeDurable(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(RequestApprovalSchema) body: RequestApprovalBody,
  ) {
    requirePermission(user, "approval:create");
    return this.opportunities.executeDurable(id, user, body);
  }

  @Post(":id/outcome")
  @ApiOperation({ summary: "Record the realized outcome of an opportunity (learning loop)" })
  recordOutcome(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(RecordOutcomeSchema) body: RecordOutcomeBody,
  ) {
    requirePermission(user, "outcome:record");
    return this.opportunities.recordOutcome(id, body);
  }
}
