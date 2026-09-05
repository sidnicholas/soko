import { Inject } from "@nestjs/common";
import { Controller, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApprovalToken, CurrentUser, requirePermission, type Principal } from "../common/current-user";
import { ZodBody } from "../common/zod-validation.pipe";
import { SendNegotiationSchema, type SendNegotiationBody } from "./negotiation.dto";
import { NegotiationService } from "./negotiation.service";

@ApiTags("negotiations")
@Controller("negotiations")
export class NegotiationsController {
  constructor(@Inject(NegotiationService) private readonly negotiations: NegotiationService) {}

  @Post(":id/send")
  @ApiOperation({ summary: "Dispatch an approved negotiation message to the counterparty's channel (requires approval token)" })
  send(
    @CurrentUser() user: Principal,
    @ApprovalToken() token: string | undefined,
    @Param("id") id: string,
    @ZodBody(SendNegotiationSchema) body: SendNegotiationBody,
  ) {
    requirePermission(user, "negotiation:send");
    return this.negotiations.send(user, token, id, body);
  }
}
