import { Module } from "@nestjs/common";
import { OutreachController, UnsubscribeController } from "./outreach.controller";
import { OutreachService } from "./outreach.service";

@Module({
  controllers: [UnsubscribeController, OutreachController],
  providers: [OutreachService],
})
export class OutreachModule {}
