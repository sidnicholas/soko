import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { listDemandHypotheses, listIntelligenceLeads, setHypothesisStatus } from "@opportunity-os/db";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";

const HypothesisStatusSchema = z.object({
  status: z.enum(["watching", "dismissed"]),
  reason: z.string().trim().min(1).max(200).nullable().optional(),
});

function days(raw: string | undefined): number {
  const n = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new BadRequestException("days must be an integer from 1 to 365");
  return n;
}

/**
 * PRD v2 FR-02 / FR-03: supply and demand intelligence, each side on its own.
 * Leads carry what was observed versus inferred; inferred demand is listed
 * separately as watchlist hypotheses and never as a buyer. Staff only.
 */
@ApiTags("intelligence")
@Controller()
export class IntelligenceController {
  @Get("supply-intelligence")
  @ApiOperation({ summary: "Supply signals: listed stock, surplus, liquidation, capacity, with terms, evidence level, last seen and the buyer search" })
  async supply(@CurrentUser() user: Principal, @Query("days") daysParam?: string) {
    requirePermission(user, "opportunity:reverify");
    return { leads: await listIntelligenceLeads(["supply"], days(daysParam)) };
  }

  @Get("demand-intelligence")
  @ApiOperation({ summary: "Observed demand (RFQs, purchase requests, needs) with the supplier search, and the watchlist of inferred demand" })
  async demand(@CurrentUser() user: Principal, @Query("days") daysParam?: string) {
    requirePermission(user, "opportunity:reverify");
    const [leads, hypotheses] = await Promise.all([listIntelligenceLeads(["demand", "problem"], days(daysParam)), listDemandHypotheses()]);
    return { leads, hypotheses };
  }

  @Post("demand-intelligence/hypotheses/:id/status")
  @ApiOperation({ summary: "Dismiss a watchlist hypothesis, or put a dismissed one back on watch" })
  async setHypothesisStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(HypothesisStatusSchema) body: z.infer<typeof HypothesisStatusSchema>) {
    // Curating the watchlist is an operator call, not an agent's.
    requirePermission(user, "outcome:record");
    const updated = await setHypothesisStatus(id, body.status, body.status === "dismissed" ? (body.reason ?? "dismissed_by_staff") : null);
    if (!updated) throw new NotFoundException(`Hypothesis ${id} not found, or no longer on the watchlist`);
    return updated;
  }
}
