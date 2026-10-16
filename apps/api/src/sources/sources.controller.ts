import { Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { z } from "zod";
import { getConfig } from "@opportunity-os/config";
import { SourceSubmissionSchema } from "@opportunity-os/intel";
import type { SourceActor } from "@opportunity-os/db";
import type { AuthenticatedRequest } from "../common/auth.guard";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { timingSafeStringEqual } from "../common/webhook-signature";
import { ZodBody } from "../common/zod-validation.pipe";
import { SourcesService } from "./sources.service";
import { SourceReviewSchema, SourceStatusSchema, type SourceReviewBody, type SourceStatusBody } from "./sources.dto";

/**
 * Resolves who is submitting: the agent's shared secret (x-intel-sources-token)
 * or a signed-in member of staff. Shared by /v1/sources and the older
 * /v1/intel/sources alias.
 */
export function submitter(req: AuthenticatedRequest, token: string | undefined): { actor: SourceActor; origin: string } {
  const expected = getConfig().intel.sourcesToken;
  if (expected && token && timingSafeStringEqual(expected, token)) return { actor: { type: "agent", id: null }, origin: "agent" };
  if (!req.authUser) throw new UnauthorizedException(req.authError ?? "Authentication required");
  requirePermission({ ...req.authUser, hasApprovedActionToken: false }, "opportunity:reverify");
  return { actor: { type: "user", id: req.authUser.userId }, origin: "staff_upload" };
}

/** PRD v2 FR-01 source registry: list, submit, review, pause/resume. */
@ApiTags("sources")
@Controller("sources")
export class SourcesController {
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  @Get()
  @ApiOperation({ summary: "Every registered source (search venues, connectors) with policy gaps and 30-day yield" })
  async list(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.sources.list();
  }

  @Get(":id")
  @ApiOperation({ summary: "One source with its review history and recent runs" })
  async detail(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.sources.detail(id);
  }

  @Post()
  @ApiOperation({ summary: "Submit sources (an agent's report or a bare array). Screened on arrival; those that pass wait for a policy review" })
  async submit(@Req() req: AuthenticatedRequest, @Headers("x-intel-sources-token") token: string | undefined, @ZodBody(SourceSubmissionSchema) body: z.infer<typeof SourceSubmissionSchema>) {
    const { actor, origin } = submitter(req, token);
    return this.sources.submit(Array.isArray(body) ? body : body.sources, actor, origin);
  }

  @Post(":id/review")
  @ApiOperation({ summary: "Record a permission-policy review; approval activates the source when the policy is satisfied" })
  async review(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(SourceReviewSchema) body: SourceReviewBody) {
    requirePermission(user, "source:review");
    return this.sources.review(id, body, { type: "user", id: user.userId });
  }

  @Post(":id/status")
  @ApiOperation({ summary: "Pause a source, or resume it (refused with the gaps when its policy is not satisfied)" })
  async setStatus(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(SourceStatusSchema) body: SourceStatusBody) {
    requirePermission(user, "source:review");
    return this.sources.setStatus(id, body.status, body.reason ?? null, { type: "user", id: user.userId });
  }
}
