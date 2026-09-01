import { Inject } from "@nestjs/common";
import { Controller, Get, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { SettlementPlanSchema, type SettlementPlanBody } from "./transaction.dto";
import { TransactionService } from "./transaction.service";

@ApiTags("transactions")
@Controller("transactions")
export class TransactionsController {
  constructor(@Inject(TransactionService) private readonly transactions: TransactionService) {}

  @Get(":id")
  @ApiOperation({ summary: "Transaction with settlement plan and milestones" })
  detail(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "transaction:read");
    return this.transactions.detail(id);
  }

  @Post(":id/settlement-plan")
  @ApiOperation({ summary: "Draft a settlement plan for the transaction" })
  createSettlementPlan(
    @CurrentUser() user: Principal,
    @Param("id") id: string,
    @ZodBody(SettlementPlanSchema) body: SettlementPlanBody,
  ) {
    requirePermission(user, "settlement:plan");
    return this.transactions.createSettlementPlan(id, body);
  }

  @Get(":id/timeline")
  @ApiOperation({ summary: "Audit timeline for the transaction" })
  timeline(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "audit:read");
    return this.transactions.timeline(id);
  }
}
