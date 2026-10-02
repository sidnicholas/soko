import { Module } from "@nestjs/common";
import { HealthController, MeController } from "./health.controller";

@Module({
  controllers: [HealthController, MeController],
})
export class HealthModule {}
