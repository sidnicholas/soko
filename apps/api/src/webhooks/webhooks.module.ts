import { Module } from "@nestjs/common";
import { SignalsModule } from "../signals/signals.module";
import { MessagingModule } from "../messaging/messaging.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [SignalsModule, MessagingModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
