import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { CrmService } from "./crm.service";

/** Pipedrive (ADR-040): elevate candidates, see and set up the connection. */
@ApiTags("crm")
@Controller("crm/pipedrive")
export class CrmController {
  constructor(@Inject(CrmService) private readonly crm: CrmService) {}

  @Get("status")
  @ApiOperation({ summary: "Whether Pipedrive is configured and the deal webhook is registered" })
  async status(@CurrentUser() user: Principal) {
    requirePermission(user, "opportunity:reverify");
    return this.crm.status();
  }

  @Post("webhook")
  @ApiOperation({ summary: "Register the deal webhook in Pipedrive (admin)" })
  async register(@CurrentUser() user: Principal) {
    requirePermission(user, "crm:configure");
    return this.crm.registerWebhook();
  }

  @Post("candidates/:id")
  @ApiOperation({ summary: "Elevate an Action Queue candidate to a Pipedrive deal (once per candidate)" })
  async elevate(@CurrentUser() user: Principal, @Param("id", ParseUUIDPipe) id: string) {
    // Working a deal is an operator's call, not an agent's.
    requirePermission(user, "outcome:record");
    return this.crm.elevateCandidate(id, user.userId);
  }
}

/** Pipedrive's deliveries. Authenticated by HTTP basic auth, not a user session. */
@ApiTags("webhooks")
@Controller("webhooks/pipedrive")
export class PipedriveWebhookController {
  constructor(@Inject(CrmService) private readonly crm: CrmService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Pipedrive webhook v2: deal created, changed or deleted" })
  async receive(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    return this.crm.handleWebhook(authorization, body);
  }
}
