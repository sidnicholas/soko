import { Inject } from "@nestjs/common";
import { Body, Controller, Headers, Param, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { WebhooksService } from "./webhooks.service";

/** External provider callbacks; excluded from the public OpenAPI doc. */
@ApiExcludeController()
@Controller("webhooks")
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Post("stripe")
  stripe(
    @Headers("stripe-signature") signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhooks.handleStripe(signature, body ?? {});
  }

  @Post("telegram")
  telegram(
    @Headers("x-telegram-bot-api-secret-token") secretToken: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhooks.handleTelegram(secretToken, body ?? {});
  }

  @Post("chain/:network")
  chain(
    @Param("network") network: string,
    @Headers("x-signature") signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhooks.handleChain(network, signature, body ?? {});
  }
}
