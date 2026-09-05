import { Inject } from "@nestjs/common";
import { Body, Controller, Get, Headers, Param, Post, Query, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { WebhooksService } from "./webhooks.service";

/** External provider callbacks; excluded from the public OpenAPI doc. */
@ApiExcludeController()
@Controller("webhooks")
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Post("stripe")
  stripe(
    @Headers("stripe-signature") signature: string | undefined,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ) {
    return this.webhooks.handleStripe(signature, req.rawBody);
  }

  @Post("circle")
  circle(
    @Headers("x-circle-signature") signature: string | undefined,
    @Headers("x-circle-key-id") keyId: string | undefined,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ) {
    return this.webhooks.handleCircle(signature, keyId, req.rawBody);
  }

  @Post("telegram")
  telegram(
    @Headers("x-telegram-bot-api-secret-token") secretToken: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhooks.handleTelegram(secretToken, body ?? {});
  }

  @Post("twilio-sms")
  twilioSms(
    @Headers("x-twilio-signature") signature: string | undefined,
    @Body() body: Record<string, string>,
    @Req() req: FastifyRequest,
  ) {
    return this.webhooks.handleTwilioSms(signature, body ?? {}, req.url);
  }

  @Post("email")
  email(@Body() body: Record<string, string>) {
    return this.webhooks.handleEmail(body ?? {});
  }

  @Get("whatsapp")
  whatsappVerify(
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") verifyToken: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
  ) {
    return this.webhooks.verifyWhatsAppSubscription(mode, verifyToken, challenge);
  }

  @Post("whatsapp")
  whatsapp(
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Req() req: RawBodyRequest<FastifyRequest>,
  ) {
    return this.webhooks.handleWhatsApp(signature, req.rawBody);
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
