import { Inject } from "@nestjs/common";
import { Controller, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { ApprovalDecisionSchema, type ApprovalDecisionBody } from "./approval.dto";
import { ApprovalService } from "./approval.service";

@ApiTags("approvals")
@Controller("approvals")
export class ApprovalsController {
  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Get()
  @ApiOperation({ summary: "Pending approvals awaiting a human decision" })
  list(@CurrentUser() user: Principal) {
    requirePermission(user, "approval:read");
    return this.approvals.listPending();
  }

  @Get(":id")
  @ApiOperation({ summary: "Approval detail" })
  get(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "approval:read");
    return this.approvals.get(id);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Approve a pending request" })
  approve(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(ApprovalDecisionSchema) body: ApprovalDecisionBody,
  ) {
    return this.approvals.decide(id, "approve", user, body);
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Reject a pending request" })
  reject(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(ApprovalDecisionSchema) body: ApprovalDecisionBody,
  ) {
    return this.approvals.decide(id, "reject", user, body);
  }

  @Post(":id/modify")
  @ApiOperation({ summary: "Approve with modified terms" })
  modify(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(ApprovalDecisionSchema) body: ApprovalDecisionBody,
  ) {
    return this.approvals.decide(id, "modify", user, body);
  }
}
