import { Module } from "@nestjs/common";
import { SourcesController } from "./sources.controller";
import { SourcesService } from "./sources.service";
import { ApifyWebhookController, IngestionController } from "./apify.controller";
import { ApifyService } from "./apify.service";

@Module({
  controllers: [SourcesController, IngestionController, ApifyWebhookController],
  providers: [SourcesService, ApifyService],
  exports: [SourcesService],
})
export class SourcesModule {}
