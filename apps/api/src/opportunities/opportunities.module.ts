import { Module } from "@nestjs/common";
import { OpportunitiesController } from "./opportunities.controller";
import { OpportunityService } from "./opportunity.service";

@Module({
  controllers: [OpportunitiesController],
  providers: [OpportunityService],
})
export class OpportunitiesModule {}
