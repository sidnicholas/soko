import { Module } from "@nestjs/common";
import { CrmController, PipedriveWebhookController } from "./crm.controller";
import { CrmService } from "./crm.service";

@Module({
  controllers: [CrmController, PipedriveWebhookController],
  providers: [CrmService],
})
export class CrmModule {}
