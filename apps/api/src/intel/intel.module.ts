import { Module } from "@nestjs/common";
import { IntelController } from "./intel.controller";
import { SourcesModule } from "../sources/sources.module";

@Module({
  imports: [SourcesModule],
  controllers: [IntelController],
})
export class IntelModule {}
