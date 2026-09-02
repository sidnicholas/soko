import { Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApprovalToken, CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import {
  DisputeMilestoneSchema,
  FreezeSettlementPlanSchema,
  RefundMilestoneSchema,
  ReleaseMilestoneSchema,
  SubmitEvidenceSchema,
  type DisputeMilestoneBody,
  type FreezeSettlementPlanBody,
  type RefundMilestoneBody,
  type ReleaseMilestoneBody,
  type SubmitEvidenceBody,
} from "./settlement.dto";
import { SettlementService } from "./settlement.service";

@ApiTags("settlement")
@Controller("settlement")
export class SettlementController {
  constructor(@Inject(SettlementService) private readonly settlement: SettlementService) {}

  @Post("plans/:planId/fund")
  @ApiOperation({ summary: "Fund a settlement plan (DRAFT -> FUNDED)" })
  fund(@CurrentUser() user: Principal, @Param("planId") planId: string) {
    requirePermission(user, "settlement:plan");
    return this.settlement.fund(planId, user);
  }

  @Post("milestones/:milestoneId/evidence")
  @ApiOperation({ summary: "Submit verified evidence; the escrow engine evaluates release conditions" })
  submitEvidence(
    @CurrentUser() user: Principal,
    @Param("milestoneId") milestoneId: string,
    @ZodBody(SubmitEvidenceSchema) body: SubmitEvidenceBody,
  ) {
    requirePermission(user, "settlement:plan");
    return this.settlement.submitEvidence(milestoneId, body);
  }

  @Get("milestones/:milestoneId/evidence")
  @ApiOperation({ summary: "Hash-chained evidence ledger for the milestone" })
  evidence(@CurrentUser() user: Principal, @Param("milestoneId") milestoneId: string) {
    requirePermission(user, "audit:read");
    return this.settlement.evidence(milestoneId);
  }

  @Post("milestones/:milestoneId/release")
  @ApiOperation({ summary: "Release a verified milestone (human approval required above threshold)" })
  release(
    @CurrentUser() user: Principal,
    @ApprovalToken() token: string | undefined,
    @Param("milestoneId") milestoneId: string,
    @ZodBody(ReleaseMilestoneSchema) body: ReleaseMilestoneBody,
  ) {
    requirePermission(user, "settlement:release");
    return this.settlement.release(milestoneId, user, token, body);
  }

  @Post("milestones/:milestoneId/dispute")
  @ApiOperation({ summary: "Dispute a milestone (blocks release; moves plan/milestone/transaction to DISPUTED)" })
  dispute(
    @CurrentUser() user: Principal,
    @Param("milestoneId") milestoneId: string,
    @ZodBody(DisputeMilestoneSchema) body: DisputeMilestoneBody,
  ) {
    requirePermission(user, "settlement:dispute");
    return this.settlement.dispute(milestoneId, user, body);
  }

  @Post("plans/:planId/freeze")
  @ApiOperation({ summary: "Freeze a settlement plan (refuses further release/refund until resolved)" })
  freeze(
    @CurrentUser() user: Principal,
    @Param("planId") planId: string,
    @ZodBody(FreezeSettlementPlanSchema) body: FreezeSettlementPlanBody,
  ) {
    requirePermission(user, "settlement:dispute");
    return this.settlement.freeze(planId, user, body);
  }

  @Post("milestones/:milestoneId/refund")
  @ApiOperation({ summary: "Refund a milestone on its rail (human approval token required, §13.5)" })
  refund(
    @CurrentUser() user: Principal,
    @ApprovalToken() token: string | undefined,
    @Param("milestoneId") milestoneId: string,
    @ZodBody(RefundMilestoneSchema) body: RefundMilestoneBody,
  ) {
    requirePermission(user, "settlement:release");
    return this.settlement.refund(milestoneId, user, token, body);
  }
}
