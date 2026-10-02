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
  const cfg = getConfig();

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: ["error", "warn", "log"],
    // Stripe (and most webhook providers) sign the exact raw request bytes;
    // re-serializing the parsed JSON body can differ byte-for-byte and always
    // fails verification. `req.rawBody` is populated on every request.
    rawBody: true,
    // The web app calls this API cross-origin from the browser. Only the
    // configured origins are allowed; outside production an unset list
    // reflects any origin so local dev needs no setup.
    cors: {
      origin: cfg.auth.webOrigins.length > 0 ? cfg.auth.webOrigins : !cfg.isProd,
      allowedHeaders: ["authorization", "content-type", "x-approval-token", "x-user-id", "x-user-role"],
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    },
  });
  app.setGlobalPrefix("v1");

  // Nest's FastifyAdapter registers its own JSON + urlencoded content-type
  // parsers during app.init() (invoked lazily by listen()). We need to
  // override the urlencoded one below, so force init now — registering our
  // parser before this point collides with Nest's later registration
  // (`FST_ERR_CTP_ALREADY_PRESENT`); registering without removing first
  // collides with Nest's own registration too.
  await app.init();

  // Twilio posts inbound SMS webhooks as application/x-www-form-urlencoded.
  // Twilio's signature is computed over the decoded param values, not raw
  // bytes, so parsing straight to an object here (rather than capturing a
  // raw buffer like Stripe's JSON parser above) is sufficient for
  // verifyTwilioSignature. This replaces Nest's default urlencoded parser.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser("application/x-www-form-urlencoded");
  fastify.addContentTypeParser(
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
    .setDescription("V1 REST surface (§16). Auth: Supabase access token as a Bearer token (§22).")
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port, docs: "/docs" }, "api.started");
}

void bootstrap();
