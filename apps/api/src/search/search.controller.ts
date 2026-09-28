import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { searchForUser } from "@opportunity-os/db";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";

/** Roles with standing read access to every mission — kept in step with missions/mission-access.ts. */
const READ_ALL_ROLES = new Set(["admin", "operator", "reviewer", "service", "agent"]);

@ApiTags("search")
@Controller("search")
export class SearchController {
  @Get()
  @ApiOperation({ summary: "Search missions and live opportunities the caller can see (Phase 4 Search/Ask)" })
  search(@CurrentUser() user: Principal, @Query("q") q: string | undefined) {
    requirePermission(user, "mission:read");
    const query = (q ?? "").trim();
    if (query.length < 2) throw new BadRequestException("Search needs at least 2 characters");
    if (query.length > 200) throw new BadRequestException("Search is limited to 200 characters");
    return searchForUser({ userId: user.userId, query, allMissions: READ_ALL_ROLES.has(user.role) });
  }
}
