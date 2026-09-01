import { Inject } from "@nestjs/common";
import { Controller, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { RequestApprovalSchema, type RequestApprovalBody } from "./opportunity.dto";
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
}
