import { Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import {
  getIntelCandidate,
  intelStats,
  listIntelQuerySources,
  listIntelQueryYield,
  listIntelQueue,
  listIntelSources,
  setIntelQuerySourceStatus,
  updateIntelCandidateStatus,
  upsertIntelQuerySource,
} from "@opportunity-os/db";
import { getConfig } from "@opportunity-os/config";
import { RAPID_MODE, SourceSubmissionSchema, sourceQueries, vetSource } from "@opportunity-os/intel";
import type { AuthenticatedRequest } from "../common/auth.guard";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { timingSafeStringEqual } from "../common/webhook-signature";
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

const SourceStatusSchema = z.object({
  status: z.enum(["active", "paused"]),
  reason: z.string().trim().min(1).max(200).nullable().optional(),
});

@ApiTags("intel")
@Controller("intel")
export class IntelController {
  @Get("sources")
  @ApiOperation({ summary: "Search sources added at runtime, with what each has yielded so far" })
  async sources(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    const [sources, yields] = await Promise.all([listIntelQuerySources(), listIntelQueryYield(5000)]);
    const byQuery = new Map(yields.map((y) => [y.query, y]));
    return sources.map((s) => {
      const rows = sourceQueries(s).map((q) => byQuery.get(q.query));
      const sum = (pick: (y: (typeof yields)[number]) => number) => rows.reduce((n, y) => n + (y ? pick(y) : 0), 0);
      return { ...s, yield: { searches: sum((y) => y.searches), results: sum((y) => y.results), leads: sum((y) => y.leads), actionable: sum((y) => y.actionable) } };
    });
  }

  @Post("sources")
  @ApiOperation({ summary: "Submit new search sources (an agent's report or a bare array). Vetted on arrival; those that pass are searched from the next run" })
  async submitSources(
    @Req() req: AuthenticatedRequest,
    @Headers("x-intel-sources-token") token: string | undefined,
    @ZodBody(SourceSubmissionSchema) body: z.infer<typeof SourceSubmissionSchema>,
  ) {
    // Two ways in: the agent's shared secret, or a signed-in member of staff.
    const expected = getConfig().intel.sourcesToken;
    const byToken = Boolean(expected && token && timingSafeStringEqual(expected, token));
    if (!byToken) {
      if (!req.authUser) throw new UnauthorizedException(req.authError ?? "Authentication required");
      requirePermission({ ...req.authUser, hasApprovedActionToken: false }, "opportunity:reverify");
    }
    const submitted = Array.isArray(body) ? body : body.sources;
    const results: { source_id: string | null; domain: string; orientation: string | null; outcome: "added" | "already_known" | "rejected"; status: string; reason: string | null }[] = [];
    for (const item of submitted) {
      const { vetted, rejected } = vetSource(item);
      if (rejected) {
        results.push({ source_id: item.source_id ?? null, domain: item.domain, orientation: null, outcome: "rejected", status: "rejected", reason: rejected });
        continue;
      }
      for (const v of vetted) {
        const { source, created } = await upsertIntelQuerySource({ ...v, origin: byToken ? "agent" : "staff_upload" });
        // An already-known source keeps the status it has; report that, not what vetting would say today.
        results.push({ source_id: v.externalId, domain: v.domain, orientation: v.orientation, outcome: created ? "added" : "already_known", status: source.status, reason: source.status_reason });
      }
    }
    const added = results.filter((r) => r.outcome === "added");
    return {
      received: submitted.length,
      added: added.length,
      added_active: added.filter((r) => r.status === "active").length,
      added_paused: added.filter((r) => r.status === "paused").length,
      already_known: results.filter((r) => r.outcome === "already_known").length,
      rejected: results.filter((r) => r.outcome === "rejected").length,
      results,
    };
  }

  @Post("sources/:id/status")
  @ApiOperation({ summary: "Pause or resume one search source" })
  async setSourceStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(SourceStatusSchema) body: z.infer<typeof SourceStatusSchema>) {
    requirePermission(user, "opportunity:reverify");
    const updated = await setIntelQuerySourceStatus(id, body.status, body.status === "active" ? null : (body.reason ?? "paused_by_staff"));
    if (!updated) throw new NotFoundException(`Source ${id} not found`);
    return updated;
  }

  @Get("queue")
  @ApiOperation({ summary: "AIOOS action queue: ACT NOW / VERIFY NEXT / WATCH / REJECTED, with spend and yield stats" })
  async queue(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    const [{ open, rejected }, stats, sources, queries] = await Promise.all([listIntelQueue(), intelStats(), listIntelSources(), listIntelQueryYield()]);
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
    return { act_now: actNow, verify_next: verifyNext, watch, rejected, stats, portfolio, sources: sources.slice(0, 20), queries };
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
