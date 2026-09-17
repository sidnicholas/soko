import { Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApprovalToken, CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { CreateAssetTransferPlanSchema, type CreateAssetTransferPlanBody } from "./asset-transfer.dto";
import { AssetTransferService } from "./asset-transfer.service";

@ApiTags("asset-transfers")
@Controller("asset-transfers")
export class AssetTransferController {
  constructor(@Inject(AssetTransferService) private readonly assetTransfers: AssetTransferService) {}

  @Post()
  @ApiOperation({ summary: "Create an asset-transfer plan for a transaction and prepare its rail reference (§19)" })
  create(@CurrentUser() user: Principal, @ZodBody(CreateAssetTransferPlanSchema) body: CreateAssetTransferPlanBody) {
    requirePermission(user, "asset_transfer:plan");
    return this.assetTransfers.create(body);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an asset-transfer plan" })
  get(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "asset_transfer:plan");
    return this.assetTransfers.get(id);
  }

  @Post(":id/execute")
  @ApiOperation({ summary: "Execute an asset transfer on its rail (human approval token required, §13.5)" })
  execute(@CurrentUser() user: Principal, @ApprovalToken() token: string | undefined, @Param("id") id: string) {
    requirePermission(user, "asset_transfer:execute");
    return this.assetTransfers.execute(id, user, token);
  }

  @Post(":id/refresh-status")
  @ApiOperation({ summary: "Poll the rail for a still-pending transfer's current status" })
  refreshStatus(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "asset_transfer:plan");
    return this.assetTransfers.refreshStatus(id, user);
  }
}
