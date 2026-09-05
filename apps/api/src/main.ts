import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const logger = createLogger("api");
  // Validate environment configuration up front; throws on invalid env (§32).
  getConfig();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ["error", "warn", "log"],
    // Stripe (and most webhook providers) sign the exact raw request bytes;
    // re-serializing the parsed JSON body can differ byte-for-byte and always
    // fails verification. `req.rawBody` is populated on every request.
    rawBody: true,
  });
  app.setGlobalPrefix("v1");

  // Twilio posts inbound SMS webhooks as application/x-www-form-urlencoded,
  // which Fastify has no parser for by default (only JSON). Twilio's
  // signature is computed over the decoded param values, not raw bytes, so
  // parsing straight to an object here (rather than capturing a raw buffer
  // like Stripe's JSON parser above) is sufficient for verifyTwilioSignature.
  app.getHttpAdapter().getInstance().addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Opportunity OS API")
    .setDescription("V1 REST surface (§16). Dev auth via x-user-id / x-user-role headers (§22).")
    .setVersion("1.0")
    .addApiKey({ type: "apiKey", name: "x-user-id", in: "header" }, "x-user-id")
    .addApiKey({ type: "apiKey", name: "x-user-role", in: "header" }, "x-user-role")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, docs: "/docs" }, "api.started");
}

void bootstrap();
