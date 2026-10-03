import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

/**
 * §32 / ADR — typed environment config. Every service reads configuration
 * through this package so cross-cutting constraints (approval timeout, refresh
 * interval, default stablecoin network) live in one validated place.
 */

/** Walks up from `startDir` looking for the pnpm workspace root. */
function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let dotenvLoaded = false;

/**
 * Loads the workspace-root `.env` into `process.env` once per process. Every
 * `dev`/`start` script here runs via tsx/turbo with cwd inside a package
 * directory (not the repo root), and nothing else in the stack loads `.env` —
 * so without this, scripts silently fall back to the schema defaults below
 * instead of failing loudly. `dotenv` never overwrites a var already set, so
 * real deployments (env vars injected by the platform) are unaffected.
 */
function loadEnvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const root = findWorkspaceRoot(process.cwd());
  if (root) loadDotenv({ path: join(root, ".env") });
}
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/opportunity_os"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  // Legacy HS256 projects only. Projects on asymmetric signing keys are
  // verified against SUPABASE_URL's published JWKS and need no secret here.
  SUPABASE_JWT_SECRET: z.string().optional(),

  // §22 authentication. The API verifies Supabase JWTs; with neither
  // SUPABASE_URL nor SUPABASE_JWT_SECRET set, every authenticated route 401s.
  // AUTH_DEV_HEADERS=true re-enables the unverified x-user-id / x-user-role
  // shim for local development — refused outright when NODE_ENV=production.
  // (Not z.coerce.boolean(): that parses the string "false" as true.)
  AUTH_DEV_HEADERS: z.enum(["true", "false"]).default("false"),
  // Comma-separated emails provisioned as `admin` on first sign-in. Everyone
  // else starts as `user`; later role changes are made on the `users` row.
  AUTH_ADMIN_EMAILS: z.string().optional(),
  // Comma-separated browser origins allowed to call the API (CORS).
  WEB_ORIGINS: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("opportunity-os"),

  LLM_DEFAULT_PROVIDER: z.string().default("echo"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Claude models behind the gateway: cheap high-volume extraction vs reasoning.
  // Blank (as copied from .env.example) means the default, not an empty model id.
  ANTHROPIC_FAST_MODEL: z.string().optional().transform((v) => v?.trim() || "claude-haiku-4-5"),
  ANTHROPIC_REASONING_MODEL: z.string().optional().transform((v) => v?.trim() || "claude-sonnet-5-5"),
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["echo", "openai", "voyage"]).default("echo"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(512),
  EMBEDDING_BACKEND: z.enum(["jsonb", "pgvector"]).default("jsonb"),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  DEFAULT_STABLECOIN_NETWORK: z.string().default("base-sepolia"),
  CHAIN_RPC_URL: z.string().optional(),
  // Circle Developer-Controlled Wallets (stablecoin rail, §19.2). All three
  // required together for real transfers; absent = simulated, same pattern
  // as STRIPE_SECRET_KEY.
  CIRCLE_API_KEY: z.string().optional(),
  CIRCLE_ENTITY_SECRET: z.string().optional(),
  CIRCLE_WALLET_ID: z.string().optional(),

  // eBay Browse API connector (§17/ADR-014, official_api). Both required
  // together for real search; absent = fixtures only, same keyless-dev
  // pattern as the Circle/Stripe rails.
  EBAY_CLIENT_ID: z.string().optional(),
  EBAY_CLIENT_SECRET: z.string().optional(),
  EBAY_MARKETPLACE_ID: z.string().default("EBAY_US"),
  // Unlike the fixture connectors, eBay Browse API rejects a blank query —
  // a coarse stand-in seed term until ingestion is driven by live demand
  // descriptions instead (see project memory backlog).
  EBAY_SEED_QUERY: z.string().default("electronics"),
  // Search term for query-driven connectors (eBay, Reverb) when no active
  // mission supplies one; falls back to EBAY_SEED_QUERY.
  CONNECTOR_SEED_QUERY: z.string().optional(),

  // Reverb public API connector (§17/ADR-014, official_api). Listing search
  // is public, so it runs keyless once enabled; the token only raises rate
  // limits. Opt-in so local dev and tests never call it by accident.
  REVERB_ENABLED: z.enum(["true", "false"]).default("false"),

  // AIOOS opportunity intelligence (docs/Opportunity_OS_AIOOS_Master_Prompt.md).
  // Runs only with both a search key and ANTHROPIC_API_KEY. The daily cap is a
  // hard ceiling on search + LLM spend across all runs that UTC day.
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  INTEL_DAILY_BUDGET_USD: z.coerce.number().nonnegative().default(1),
  INTEL_QUERIES_PER_RUN: z.coerce.number().int().positive().default(8),
  // Must match the worker-intel cron (every 6h = 4). Paces the daily cap across runs.
  INTEL_RUNS_PER_DAY: z.coerce.number().int().positive().default(4),
  INTEL_MAX_ASSESSMENTS: z.coerce.number().int().nonnegative().default(3),
  // Built-in fixture connectors (static fake listings). Default: on outside
  // production, off in production so fake supply never reaches real data.
  FIXTURE_CONNECTORS: z.enum(["true", "false"]).optional(),
  REVERB_API_TOKEN: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_URL: z.string().optional(),

  // Twilio SMS inbound (§11 messaging backlog). All three required together
  // for real send/verify; absent = the webhook rejects everything, same
  // keyless-dev pattern as the other providers.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  // Twilio signs the exact webhook URL it called (protocol+host+path), not
  // just the payload — unlike Stripe/Circle's payload-only HMAC, this must
  // match byte-for-byte what Twilio saw, which a reverse proxy can rewrite.
  // No default: absent means Twilio signature verification cannot run.
  PUBLIC_API_BASE_URL: z.string().optional(),

  // Email inbound (Mailgun Routes, §11 messaging backlog) + outbound (SMTP,
  // reusing EMAIL_FROM/SMTP_URL above rather than adding a parallel set).
  MAILGUN_SIGNING_KEY: z.string().optional(),

  // WhatsApp Business Cloud API (Meta), §11 messaging backlog.
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  // Chosen by us, echoed back by Meta during the GET webhook-verification
  // handshake — not a secret shared with Meta in advance like the others.
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  APPROVAL_TOKEN_SECRET: z.string().default("change-me"),
  AUDIT_ANCHOR_ENABLED: z.coerce.boolean().default(false),

  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),
  MISSION_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  SUPPLY_STALE_MINUTES: z.coerce.number().int().positive().default(1440),
  SETTLEMENT_AUTO_RELEASE_THRESHOLD_MINOR: z.coerce.number().int().nonnegative().default(100000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Structured, namespaced configuration derived from validated env. */
export interface AppConfig {
  env: Env["NODE_ENV"];
  isProd: boolean;
  logLevel: Env["LOG_LEVEL"];
  db: { url: string };
  supabase: { url?: string; anonKey?: string; serviceRoleKey?: string; jwtSecret?: string };
  auth: { devHeaders: boolean; adminEmails: string[]; webOrigins: string[] };
  redis: { url: string };
  temporal: { address: string; namespace: string; taskQueue: string };
  llm: {
    defaultProvider: string;
    openaiKey?: string;
    anthropicKey?: string;
    anthropicFastModel: string;
    anthropicReasoningModel: string;
    voyageKey?: string;
    embeddingProvider: "echo" | "openai" | "voyage";
    embeddingModel: string;
    embeddingDim: number;
    embeddingBackend: "jsonb" | "pgvector";
  };
  settlement: {
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
    defaultStablecoinNetwork: string;
    chainRpcUrl?: string;
    circleApiKey?: string;
    circleEntitySecret?: string;
    circleWalletId?: string;
  };
  notifications: {
    telegramBotToken?: string;
    telegramChatId?: string;
    emailFrom?: string;
    smtpUrl?: string;
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioFromNumber?: string;
    publicApiBaseUrl?: string;
    mailgunSigningKey?: string;
    whatsappAccessToken?: string;
    whatsappPhoneNumberId?: string;
    whatsappAppSecret?: string;
    whatsappVerifyToken?: string;
  };
  connectors: {
    ebayClientId?: string;
    ebayClientSecret?: string;
    ebayMarketplaceId: string;
    ebaySeedQuery: string;
    seedQuery: string;
    reverbEnabled: boolean;
    reverbApiToken?: string;
    fixtures: boolean;
  };
  intel: { braveApiKey?: string; dailyBudgetUsd: number; runsPerDay: number; queriesPerRun: number; maxAssessments: number };
  security: { approvalTokenSecret: string; auditAnchorEnabled: boolean };
  policy: {
    approvalTimeoutMinutes: number;
    missionRefreshIntervalMinutes: number;
    supplyStaleMinutes: number;
    settlementAutoReleaseThresholdMinor: number;
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function toConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    isProd: env.NODE_ENV === "production",
    logLevel: env.LOG_LEVEL,
    db: { url: env.DATABASE_URL },
    supabase: {
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: env.SUPABASE_JWT_SECRET,
    },
    auth: {
      devHeaders: env.AUTH_DEV_HEADERS === "true",
      adminEmails: csv(env.AUTH_ADMIN_EMAILS).map((e) => e.toLowerCase()),
      webOrigins: csv(env.WEB_ORIGINS),
    },
    redis: { url: env.REDIS_URL },
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      taskQueue: env.TEMPORAL_TASK_QUEUE,
    },
    llm: {
      defaultProvider: env.LLM_DEFAULT_PROVIDER,
      openaiKey: env.OPENAI_API_KEY,
      anthropicKey: env.ANTHROPIC_API_KEY,
      anthropicFastModel: env.ANTHROPIC_FAST_MODEL,
      anthropicReasoningModel: env.ANTHROPIC_REASONING_MODEL,
      voyageKey: env.VOYAGE_API_KEY,
      embeddingProvider: env.EMBEDDING_PROVIDER,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDim: env.EMBEDDING_DIM,
      embeddingBackend: env.EMBEDDING_BACKEND,
    },
    settlement: {
      stripeSecretKey: env.STRIPE_SECRET_KEY,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      defaultStablecoinNetwork: env.DEFAULT_STABLECOIN_NETWORK,
      chainRpcUrl: env.CHAIN_RPC_URL,
      circleApiKey: env.CIRCLE_API_KEY,
      circleEntitySecret: env.CIRCLE_ENTITY_SECRET,
      circleWalletId: env.CIRCLE_WALLET_ID,
    },
    notifications: {
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      emailFrom: env.EMAIL_FROM,
      smtpUrl: env.SMTP_URL,
      twilioAccountSid: env.TWILIO_ACCOUNT_SID,
      twilioAuthToken: env.TWILIO_AUTH_TOKEN,
      twilioFromNumber: env.TWILIO_FROM_NUMBER,
      publicApiBaseUrl: env.PUBLIC_API_BASE_URL,
      mailgunSigningKey: env.MAILGUN_SIGNING_KEY,
      whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN,
      whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      whatsappAppSecret: env.WHATSAPP_APP_SECRET,
      whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN,
    },
    connectors: {
      ebayClientId: env.EBAY_CLIENT_ID,
      ebayClientSecret: env.EBAY_CLIENT_SECRET,
      ebayMarketplaceId: env.EBAY_MARKETPLACE_ID,
      ebaySeedQuery: env.EBAY_SEED_QUERY,
      seedQuery: env.CONNECTOR_SEED_QUERY ?? env.EBAY_SEED_QUERY,
      reverbEnabled: env.REVERB_ENABLED === "true",
      reverbApiToken: env.REVERB_API_TOKEN,
      fixtures: env.FIXTURE_CONNECTORS ? env.FIXTURE_CONNECTORS === "true" : env.NODE_ENV !== "production",
    },
    intel: {
      braveApiKey: env.BRAVE_SEARCH_API_KEY,
      dailyBudgetUsd: env.INTEL_DAILY_BUDGET_USD,
      runsPerDay: env.INTEL_RUNS_PER_DAY,
      queriesPerRun: env.INTEL_QUERIES_PER_RUN,
      maxAssessments: env.INTEL_MAX_ASSESSMENTS,
    },
    security: {
      approvalTokenSecret: env.APPROVAL_TOKEN_SECRET,
      auditAnchorEnabled: env.AUDIT_ANCHOR_ENABLED,
    },
    policy: {
      approvalTimeoutMinutes: env.APPROVAL_TIMEOUT_MINUTES,
      missionRefreshIntervalMinutes: env.MISSION_REFRESH_INTERVAL_MINUTES,
      supplyStaleMinutes: env.SUPPLY_STALE_MINUTES,
      settlementAutoReleaseThresholdMinor: env.SETTLEMENT_AUTO_RELEASE_THRESHOLD_MINOR,
    },
  };
}

let cached: AppConfig | undefined;

/** Parse + validate an env bag (defaults to process.env). Throws on invalid config. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.AUTH_DEV_HEADERS === "true") {
    throw new Error("Invalid environment configuration: AUTH_DEV_HEADERS=true is not allowed when NODE_ENV=production");
  }
  return toConfig(parsed.data);
}

/** Process-wide singleton. */
export function getConfig(): AppConfig {
  if (!cached) {
    loadEnvOnce();
    cached = loadConfig();
  }
  return cached;
}

/** Test/DI helper. */
export function resetConfig(): void {
  cached = undefined;
}
