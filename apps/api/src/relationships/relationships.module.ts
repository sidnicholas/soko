import { Module } from "@nestjs/common";
import { CrmModule } from "../crm/crm.module";
import { RelationshipsController } from "./relationships.controller";
import { RelationshipsService } from "./relationships.service";

@Module({
  imports: [CrmModule],
  controllers: [RelationshipsController],
  providers: [RelationshipsService],
})
export class RelationshipsModule {}
