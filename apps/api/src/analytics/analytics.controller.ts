import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { yieldReport } from "@opportunity-os/db";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";

/**
 * PRD v2 P0 baseline: spend and yield over time, measured before anything is
 * optimized. Staff only, like the intel queue it summarizes.
 */
@ApiTags("analytics")
@Controller("analytics")
export class AnalyticsController {
  @Get("yield")
  @ApiOperation({ summary: "Intel spend and yield per day and per search provider, and the opportunity funnel" })
  async yield(@CurrentUser() user: Principal, @Query("days") daysParam?: string) {
    requirePermission(user, "opportunity:reverify");
    const days = daysParam === undefined ? 30 : Number(daysParam);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException("days must be an integer from 1 to 365");
    return yieldReport(days);
  }
}
