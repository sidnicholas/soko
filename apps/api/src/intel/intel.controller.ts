import { BadRequestException, Controller, Get, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  followUpCounts,
  getIntelCandidate,
  intelStats,
  listClosedCandidates,
  listEconomicsVersions,
  listEvidence,
  listFollowUps,
  listIntelQueryYield,
  listIntelQueue,
  listIntelSources,
  logTouch,
  snoozeCandidate,
  updateIntelCandidateStatus,
} from "@opportunity-os/db";
import { RANKING_PROFILES, rankDeals, type DealEconomics, type RankingProfile } from "@opportunity-os/scoring";
import { RAPID_MODE, SourceSubmissionSchema } from "@opportunity-os/intel";
import type { AuthenticatedRequest } from "../common/auth.guard";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { SourcesService } from "../sources/sources.service";
import { SourceStatusSchema } from "../sources/sources.dto";
import { submitter } from "../sources/sources.controller";

/** The delivered-cost economics stored on a candidate, when it has them. */
function dealOf(c: { economics: unknown }): DealEconomics | null {
  const deal = (c.economics as { deal?: DealEconomics } | null)?.deal;
  return deal && Array.isArray(deal.netProfitUsd) ? deal : null;
}

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
  /** Why, in the operator's own words — what the reason code cannot say. */
  note: z.string().trim().max(2000).nullable().optional(),
});

/** A touch logged by hand from Follow-ups (ADR-047). */
const TouchSchema = z.object({
  kind: z.enum(["follow_up", "responded", "note"]),
  channel: z.enum(["email", "phone", "text", "platform_message", "in_person", "other"]).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

/** Remind me on a date (ISO), or null to clear. At most a year out. */
const SnoozeSchema = z.object({
  until: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .refine((v) => v === null || (Date.parse(v) > Date.now() && Date.parse(v) < Date.now() + 366 * 86_400_000), "until must be in the future and within a year"),
});

@ApiTags("intel")
@Controller("intel")
export class IntelController {
  constructor(@Inject(SourcesService) private readonly registry: SourcesService) {}

  // Older paths for the source registry, kept so an agent already posting here
  // keeps working. They behave exactly like /v1/sources (submissions wait for
  // a policy review); new callers use /v1/sources.
  @Get("sources")
  @ApiOperation({ summary: "Alias of GET /v1/sources" })
  async sources(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.registry.list();
  }

  @Post("sources")
  @ApiOperation({ summary: "Alias of POST /v1/sources" })
  async submitSources(
    @Req() req: AuthenticatedRequest,
    @Headers("x-intel-sources-token") token: string | undefined,
    @ZodBody(SourceSubmissionSchema) body: z.infer<typeof SourceSubmissionSchema>,
  ) {
    const { actor, origin } = submitter(req, token);
    return this.registry.submit(Array.isArray(body) ? body : body.sources, actor, origin);
  }

  @Post("sources/:id/status")
  @ApiOperation({ summary: "Alias of POST /v1/sources/:id/status" })
  async setSourceStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(SourceStatusSchema) body: z.infer<typeof SourceStatusSchema>) {
    requirePermission(user, "source:review");
    return this.registry.setStatus(id, body.status, body.reason ?? null, { type: "user", id: user.userId });
  }

  @Get("queue")
  @ApiOperation({ summary: "AIOOS action queue: ACT NOW / VERIFY NEXT / WATCH / REJECTED, each bucket ordered by a ranking profile (default profit_first)" })
  async queue(@CurrentUser() user: Principal, @Query("rank") rankParam?: string) {
    requirePermission(user, "opportunity:reverify");
    const rank = (rankParam ?? "profit_first") as RankingProfile;
    if (!RANKING_PROFILES.includes(rank)) throw new BadRequestException(`rank must be one of ${RANKING_PROFILES.join(", ")}`);
    const [{ open: byScore, rejected }, stats, sources, queries] = await Promise.all([listIntelQueue(), intelStats(), listIntelSources(), listIntelQueryYield()]);
    // PRD v2 §2: profit, then probability of close, then time to cash; candidates assessed before
    // delivered-cost economics existed have none and keep their score order after the rest.
    const open = rankDeals(byScore, dealOf, rank);
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
    const followUps = followUpCounts(await listFollowUps());
    return { rank, act_now: actNow, verify_next: verifyNext, watch, rejected, stats, portfolio, sources: sources.slice(0, 20), queries, follow_ups: followUps };
  }

  @Get("candidates/:id")
  @ApiOperation({ summary: "One candidate with its lead, evidence, economics and outreach" })
  async candidate(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    const c = await getIntelCandidate(id);
    if (!c) throw new NotFoundException(`Candidate ${id} not found`);
    // PRD v2 FR-04: what it rests on (the lead's page and facts, the counterpart used, the contact) and every economics version.
    const [leadEvidence, candidateEvidence, economicsVersions] = await Promise.all([listEvidence("intel_lead", c.lead_id), listEvidence("intel_candidate", c.id), listEconomicsVersions("intel_candidate", c.id)]);
    return { ...c, evidence: [...leadEvidence, ...candidateEvidence], economics_versions: economicsVersions };
  }

  @Post("candidates/:id/status")
  @ApiOperation({ summary: "Record what happened (contacted, won, lost + reason) — the learning signal (AIOOS §24-§25)" })
  async status(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(OutcomeSchema) body: z.infer<typeof OutcomeSchema>) {
    requirePermission(user, "opportunity:reverify");
    const updated = await updateIntelCandidateStatus(id, {
      status: body.status,
      reason: body.reason ?? null,
      realizedUsd: body.realized_usd ?? null,
      ...(body.note !== undefined ? { note: body.note || null } : {}),
    }, { type: "user", id: user.userId });
    if (!updated) throw new NotFoundException(`Candidate ${id} not found`);
    return getIntelCandidate(id);
  }

  @Get("follow-ups")
  @ApiOperation({ summary: "Candidates being worked (contacted, responded) with their follow-up plan, due first (ADR-047)" })
  async followUps(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    const items = await listFollowUps();
    return { counts: followUpCounts(items), items };
  }

  @Get("closed")
  @ApiOperation({ summary: "Closed archive: won, lost and dismissed candidates, most recently closed first" })
  async closed(@CurrentUser() user: Principal, @Query("status") status?: string) {
    requirePermission(user, "opportunity:reverify");
    if (status && !["won", "lost", "dismissed"].includes(status)) throw new BadRequestException("status must be won, lost or dismissed");
    return { items: await listClosedCandidates({ status: status as "won" | "lost" | "dismissed" | undefined }) };
  }

  @Post("candidates/:id/touches")
  @ApiOperation({ summary: "Log a follow-up, a response or a note on a candidate" })
  async touch(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(TouchSchema) body: z.infer<typeof TouchSchema>) {
    requirePermission(user, "opportunity:reverify");
    if (body.kind === "note" && !body.note) throw new BadRequestException("A note needs text");
    const ok = await logTouch({ candidateId: id, kind: body.kind, channel: body.channel ?? null, note: body.note ?? null }, { type: "user", id: user.userId });
    if (!ok) throw new NotFoundException(`Candidate ${id} not found`);
    return { ok: true };
  }

  @Post("candidates/:id/snooze")
  @ApiOperation({ summary: "Remind me on a date: hides the follow-up until then (null clears it)" })
  async snooze(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(SnoozeSchema) body: z.infer<typeof SnoozeSchema>) {
    requirePermission(user, "opportunity:reverify");
    if (!(await snoozeCandidate(id, body.until))) throw new NotFoundException(`Candidate ${id} is not being worked`);
    return { ok: true };
  }
}
