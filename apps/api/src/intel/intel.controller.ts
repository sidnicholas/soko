import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { getIntelCandidate, intelStats, listIntelQueue, listIntelSources, updateIntelCandidateStatus } from "@opportunity-os/db";
import { RAPID_MODE } from "@opportunity-os/intel";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";

/** AIOOS §26 queue sizes: a handful to act on, a short list to check. */
const ACT_NOW_LIMIT = 3;
const VERIFY_NEXT_LIMIT = 15;
const WATCH_LIMIT = 50;

/** AIOOS §24 failure reasons + §25 success stages. */
const OutcomeSchema = z.object({
  status: z.enum(["open", "contacted", "responded", "won", "lost", "dismissed"]),
  reason: z
    .enum([
      "stale",
      "already_sold",
      "no_response",
      "wrong_decision_maker",
      "economics_failed",
      "supply_unavailable",
      "demand_not_genuine",
      "fee_impossible",
      "regulatory_barrier",
      "fraud",
      "competitor_won",
      "price_mismatch",
      "shipping_killed_economics",
      "insufficient_trust",
      "payment_too_slow",
      "meeting",
      "quote",
      "agreement",
      "deposit",
      "completed",
      "not_relevant",
    ])
    .nullable()
    .optional(),
  realized_usd: z.number().nonnegative().nullable().optional(),
});

@ApiTags("intel")
@Controller("intel")
export class IntelController {
  @Get("queue")
  @ApiOperation({ summary: "AIOOS action queue: ACT NOW / VERIFY NEXT / WATCH / REJECTED, with spend and yield stats" })
  async queue(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    const [{ open, rejected }, stats, sources] = await Promise.all([listIntelQueue(), intelStats(), listIntelSources()]);
    const actNowAll = open.filter((c) => c.bucket === "act_now");
    const actNow = actNowAll.slice(0, ACT_NOW_LIMIT);
    // Over-limit ACT NOW items wait at the top of VERIFY NEXT rather than disappearing.
    const verifyNext = [...actNowAll.slice(ACT_NOW_LIMIT), ...open.filter((c) => c.bucket === "verify_next")].slice(0, VERIFY_NEXT_LIMIT);
    const watch = open.filter((c) => c.bucket === "watch").slice(0, WATCH_LIMIT);
    // §20 portfolio view: realistic near-term EV of what is actionable, against the experiment target.
    const actionable = [...actNow, ...verifyNext];
    const portfolio = {
      targetUsd: RAPID_MODE.revenueTargetUsd,
      evLowUsd: actionable.reduce((s, c) => s + Number(c.ev_low_usd), 0),
      evHighUsd: actionable.reduce((s, c) => s + Number(c.ev_high_usd), 0),
      realizedUsd: stats.realizedUsd,
    };
    return { act_now: actNow, verify_next: verifyNext, watch, rejected, stats, portfolio, sources: sources.slice(0, 20) };
  }

  @Get("candidates/:id")
  @ApiOperation({ summary: "One candidate with its lead, evidence, economics and outreach" })
  async candidate(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    const c = await getIntelCandidate(id);
    if (!c) throw new NotFoundException(`Candidate ${id} not found`);
    return c;
  }

  @Post("candidates/:id/status")
  @ApiOperation({ summary: "Record what happened (contacted, won, lost + reason) — the learning signal (AIOOS §24-§25)" })
  async status(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(OutcomeSchema) body: z.infer<typeof OutcomeSchema>) {
    requirePermission(user, "opportunity:reverify");
    const updated = await updateIntelCandidateStatus(id, { status: body.status, reason: body.reason ?? null, realizedUsd: body.realized_usd ?? null });
    if (!updated) throw new NotFoundException(`Candidate ${id} not found`);
    return getIntelCandidate(id);
  }
}
