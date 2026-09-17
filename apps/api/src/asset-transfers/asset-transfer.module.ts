import { Module } from "@nestjs/common";
import { AssetTransferController } from "./asset-transfer.controller";
import { AssetTransferService } from "./asset-transfer.service";

@Module({ controllers: [AssetTransferController], providers: [AssetTransferService] })
export class AssetTransferModule {}
