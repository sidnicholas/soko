import { z } from "zod";

/**
 * §32 / ADR — typed environment config. Every service reads configuration
 * through this package so cross-cutting constraints (approval timeout, refresh
 * interval, default stablecoin network) live in one validated place.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/opportunity_os"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("opportunity-os"),

  LLM_DEFAULT_PROVIDER: z.string().default("echo"),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_PROVIDER: z.enum(["echo", "openai", "voyage"]).default("echo"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(512),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  DEFAULT_STABLECOIN_NETWORK: z.string().default("base-sepolia"),
  CHAIN_RPC_URL: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SMTP_URL: z.string().optional(),

  APPROVAL_TOKEN_SECRET: z.string().default("change-me"),
  AUDIT_ANCHOR_ENABLED: z.coerce.boolean().default(false),

  APPROVAL_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),
  MISSION_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  SUPPLY_STALE_MINUTES: z.coerce.number().int().positive().default(1440),
});

export type Env = z.infer<typeof EnvSchema>;

/** Structured, namespaced configuration derived from validated env. */
export interface AppConfig {
  env: Env["NODE_ENV"];
  isProd: boolean;
  logLevel: Env["LOG_LEVEL"];
  db: { url: string };
  supabase: { url?: string; anonKey?: string; serviceRoleKey?: string };
  redis: { url: string };
  temporal: { address: string; namespace: string; taskQueue: string };
  llm: {
    defaultProvider: string;
    openaiKey?: string;
    anthropicKey?: string;
    voyageKey?: string;
    embeddingProvider: "echo" | "openai" | "voyage";
    embeddingModel: string;
    embeddingDim: number;
  };
  settlement: {
    stripeSecretKey?: string;
    stripeWebhookSecret?: string;
    defaultStablecoinNetwork: string;
    chainRpcUrl?: string;
  };
  notifications: {
    telegramBotToken?: string;
    telegramChatId?: string;
    emailFrom?: string;
    smtpUrl?: string;
  };
  security: { approvalTokenSecret: string; auditAnchorEnabled: boolean };
  policy: { approvalTimeoutMinutes: number; missionRefreshIntervalMinutes: number; supplyStaleMinutes: number };
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
      voyageKey: env.VOYAGE_API_KEY,
      embeddingProvider: env.EMBEDDING_PROVIDER,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDim: env.EMBEDDING_DIM,
    },
    settlement: {
      stripeSecretKey: env.STRIPE_SECRET_KEY,
      stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
      defaultStablecoinNetwork: env.DEFAULT_STABLECOIN_NETWORK,
      chainRpcUrl: env.CHAIN_RPC_URL,
    },
    notifications: {
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      emailFrom: env.EMAIL_FROM,
      smtpUrl: env.SMTP_URL,
    },
    security: {
      approvalTokenSecret: env.APPROVAL_TOKEN_SECRET,
      auditAnchorEnabled: env.AUDIT_ANCHOR_ENABLED,
    },
    policy: {
      approvalTimeoutMinutes: env.APPROVAL_TIMEOUT_MINUTES,
      missionRefreshIntervalMinutes: env.MISSION_REFRESH_INTERVAL_MINUTES,
      supplyStaleMinutes: env.SUPPLY_STALE_MINUTES,
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
  return toConfig(parsed.data);
}

/** Process-wide singleton. */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test/DI helper. */
export function resetConfig(): void {
  cached = undefined;
}
