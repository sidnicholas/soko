import { Module } from "@nestjs/common";
import { IntelController } from "./intel.controller";

@Module({
  controllers: [IntelController],
})
export class IntelModule {}
