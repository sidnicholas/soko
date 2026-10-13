import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  createOffNetworkMatch,
  listMarketListings,
  listOffNetworkMatches,
  updateOffNetworkMatchStatus,
  type ListingOrigin,
  type MarketListing,
} from "@opportunity-os/db";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";

const SIDES = new Set(["demand", "supply"]);
const ORIGINS = new Set(["intel", "marketplace"]);

/** A listing id as the marketplace view returns it: `<origin>:<uuid>`. */
const LISTING_ID = /^(intel|marketplace):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const text = (max: number) => z.string().trim().min(1).max(max);

const OffNetworkSchema = z.object({
  counterparty_name: text(200),
  counterparty_contact: text(300).nullable().optional(),
  terms: text(2000).nullable().optional(),
  price_minor: z.number().int().nonnegative().max(2_000_000_000).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
});

const OffNetworkStatusSchema = z.object({
  status: z.enum(["open", "contacted", "agreed", "won", "lost", "dismissed"]),
  note: text(1000).nullable().optional(),
});

/** A listing still needs an opposite side when the system found none and the operator has no live off-network deal on it. */
function unmatchedListing(l: MarketListing): boolean {
  return !l.matched && !l.off_network.some((m) => m.status !== "lost" && m.status !== "dismissed");
}

function count(rows: MarketListing[]) {
  return { total: rows.length, unmatched: rows.filter(unmatchedListing).length };
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

    const [all, offNetwork] = await Promise.all([listMarketListings(), listOffNetworkMatches()]);
    const rows = all.filter((r) => (!side || r.side === side) && (!origin || r.origin === origin) && (unmatched !== "true" || unmatchedListing(r)));
    const demand = rows.filter((r) => r.side === "demand");
    const supply = rows.filter((r) => r.side === "supply");
    // Every off-network deal, including ones whose listing has since aged out of the capped lists above.
    return { demand, supply, counts: { demand: count(demand), supply: count(supply) }, off_network: offNetwork };
  }

  @Post("listings/:id/off-network")
  @ApiOperation({ summary: "\"I have the other side\": record a counterparty held outside the network against a listing" })
  async addOffNetwork(@CurrentUser() user: Principal, @Param("id") id: string, @ZodBody(OffNetworkSchema) body: z.infer<typeof OffNetworkSchema>) {
    requirePermission(user, "opportunity:reverify");
    const parsed = LISTING_ID.exec(id);
    if (!parsed) throw new BadRequestException("Listing id must look like 'intel:<uuid>' or 'marketplace:<uuid>'");
    const created = await createOffNetworkMatch({
      origin: parsed[1]!.toLowerCase() as ListingOrigin,
      ref: parsed[2]!.toLowerCase(),
      counterpartyName: body.counterparty_name,
      counterpartyContact: body.counterparty_contact ?? null,
      terms: body.terms ?? null,
      priceMinor: body.price_minor ?? null,
      currency: body.price_minor == null ? null : (body.currency ?? "USD"),
      createdBy: user.userId,
    });
    if (!created) throw new NotFoundException(`Listing ${id} not found`);
    return created;
  }

  @Post("off-network/:id/status")
  @ApiOperation({ summary: "Move an off-network deal along: contacted, agreed, won, lost or dismissed" })
  async setOffNetworkStatus(
    @CurrentUser() user: Principal,
    @Param("id", ParseUUIDPipe) id: string,
    @ZodBody(OffNetworkStatusSchema) body: z.infer<typeof OffNetworkStatusSchema>,
  ) {
    requirePermission(user, "opportunity:reverify");
    const updated = await updateOffNetworkMatchStatus(id, { status: body.status, note: body.note });
    if (!updated) throw new NotFoundException(`Off-network match ${id} not found`);
    return updated;
  }
}
