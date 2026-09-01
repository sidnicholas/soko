import { Module } from "@nestjs/common";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalService } from "./approval.service";

@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalService],
})
export class ApprovalsModule {}
