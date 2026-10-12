import { Module } from "@nestjs/common";
import { MarketplaceController } from "./marketplace.controller";

@Module({
  controllers: [MarketplaceController],
})
export class MarketplaceModule {}
