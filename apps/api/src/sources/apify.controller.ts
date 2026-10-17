import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { ApifyConfigSchema, ApifySourceSchema, QuarantineDecisionSchema, type ApifyConfigBody, type ApifySourceBody, type QuarantineDecisionBody } from "./apify.dto";
import { ApifyService } from "./apify.service";

/**
 * Apify actors and the ingestion quarantine (PRD v2 FR-01, ADR-042). Staff
 * register and configure; only a person with source:review runs an actor or
 * decides quarantined data (never agents).
 */
@ApiTags("ingestion")
@Controller("ingestion")
export class IngestionController {
  constructor(@Inject(ApifyService) private readonly apify: ApifyService) {}

  @Get("apify/status")
  @ApiOperation({ summary: "Whether Apify is configured, the webhook can be used, and the daily ceiling" })
  status(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.apify.status();
  }

  @Post("apify/sources")
  @ApiOperation({ summary: "Register an Apify actor as a source (proposed until a policy review approves it)" })
  async register(@CurrentUser() user: Principal, @ZodBody(ApifySourceSchema) body: ApifySourceBody) {
    requirePermission(user, "opportunity:reverify");
    return this.apify.register(body, { type: "user", id: user.userId });
  }

  @Get("apify/sources/:id")
  @ApiOperation({ summary: "An actor source's configuration, recent runs and pending quarantine" })
  async detail(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "opportunity:reverify");
    return this.apify.detail(id);
  }

  @Patch("apify/sources/:id")
  @ApiOperation({ summary: "Change an actor's configuration; a different actor or build needs a new review" })
  async configure(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(ApifyConfigSchema) body: ApifyConfigBody) {
    requirePermission(user, "source:review");
    return this.apify.configure(id, body, { type: "user", id: user.userId });
  }

  @Post("apify/sources/:id/run")
  @ApiOperation({ summary: "Start a run now (policy, budget, backoff and one-at-a-time still apply)" })
  async run(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    requirePermission(user, "source:review");
    return this.apify.runNow(id);
  }

  @Get("quarantine")
  @ApiOperation({ summary: "Items held back from ingestion, newest first" })
  async quarantine(@CurrentUser() user: Principal, @Query("status") status?: string) {
    requirePermission(user, "opportunity:reverify");
    return this.apify.quarantine(status === "released" || status === "discarded" ? status : "pending");
  }

  @Post("quarantine/:id")
  @ApiOperation({ summary: "Release (ingest as is) or discard a quarantined item" })
  async decide(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string, @ZodBody(QuarantineDecisionSchema) body: QuarantineDecisionBody) {
    requirePermission(user, "source:review");
    return this.apify.decide(id, body, { type: "user", id: user.userId });
  }
}

/** Apify's run-completion calls. Authenticated by the secret header, not a user session. */
@ApiTags("webhooks")
@Controller("webhooks/apify")
export class ApifyWebhookController {
  constructor(@Inject(ApifyService) private readonly apify: ApifyService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Apify ad-hoc webhook: an actor run ended" })
  receive(@Headers("x-apify-webhook-secret") secret: string | undefined, @Body() body: unknown) {
    return this.apify.handleWebhook(secret, body);
  }
}
