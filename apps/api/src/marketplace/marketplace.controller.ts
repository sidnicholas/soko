import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { listMarketListings, type MarketListing } from "@opportunity-os/db";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";

const SIDES = new Set(["demand", "supply"]);
const ORIGINS = new Set(["intel", "marketplace"]);

function count(rows: MarketListing[]) {
  return { total: rows.length, unmatched: rows.filter((r) => !r.matched).length };
}

@ApiTags("marketplace")
@Controller("marketplace")
export class MarketplaceController {
  @Get("listings")
  @ApiOperation({ summary: "Every demand and supply record, listed independently of whether it was matched" })
  @ApiQuery({ name: "side", required: false, enum: ["demand", "supply"] })
  @ApiQuery({ name: "origin", required: false, enum: ["intel", "marketplace"] })
  @ApiQuery({ name: "unmatched", required: false, description: "`true` keeps only records with no opposite side yet" })
  async listings(
    @CurrentUser() user: Principal,
    @Query("side") side: string | undefined,
    @Query("origin") origin: string | undefined,
    @Query("unmatched") unmatched: string | undefined,
  ) {
    // Staff-only: the listing includes every user's mission demands.
    requirePermission(user, "opportunity:reverify");
    if (side !== undefined && !SIDES.has(side)) throw new BadRequestException("side must be 'demand' or 'supply'");
    if (origin !== undefined && !ORIGINS.has(origin)) throw new BadRequestException("origin must be 'intel' or 'marketplace'");

    const all = await listMarketListings();
    const rows = all.filter((r) => (!side || r.side === side) && (!origin || r.origin === origin) && (unmatched !== "true" || !r.matched));
    const demand = rows.filter((r) => r.side === "demand");
    const supply = rows.filter((r) => r.side === "supply");
    return { demand, supply, counts: { demand: count(demand), supply: count(supply) } };
  }
}
