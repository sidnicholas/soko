import { Controller, Get, Inject, Param } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { EntityService } from "./entity.service";

@ApiTags("entities")
@Controller("entities")
export class EntitiesController {
  constructor(@Inject(EntityService) private readonly entities: EntityService) {}

  @Get(":id")
  @ApiOperation({ summary: "Canonical entity with members, price stats, and comparables" })
  intelligence(@CurrentUser() user: Principal, @Param("id") id: string) {
    requirePermission(user, "opportunity:read");
    return this.entities.intelligence(id);
  }
}
