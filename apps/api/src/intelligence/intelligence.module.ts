import { Module } from "@nestjs/common";
import { IntelligenceController } from "./intelligence.controller";

@Module({
  controllers: [IntelligenceController],
})
export class IntelligenceModule {}
