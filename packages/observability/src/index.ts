import pino, { type Logger } from "pino";
import { getConfig } from "@opportunity-os/config";

/**
 * §25 — structured JSON logs with the required correlation dimensions
 * (trace/correlation id, mission id, opportunity id, workflow id, agent task
 * id, model/provider/version, cost, error class, latency, retries).
 */
export interface LogContext {
  correlationId?: string;
  missionId?: string;
  opportunityId?: string;
  workflowId?: string;
  agentTaskId?: string;
  provider?: string;
  model?: string;
  modelVersion?: string;
}

let root: Logger | undefined;

export function rootLogger(): Logger {
  if (!root) {
    root = pino({ level: getConfig().logLevel, base: { service: "opportunity-os" } });
  }
  return root;
}

/** Create a child logger bound to a stable set of correlation fields. */
export function createLogger(service: string, ctx: LogContext = {}): Logger {
  return rootLogger().child({ service, ...ctx });
}

/** §32.9 — per-task token + cost telemetry record for the LLM gateway/tooling. */
export interface TokenTelemetry {
  taskType: string;
  sessionId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedUsd: number;
  contextSize: number;
  artifactReads: number;
  retryCount: number;
}

export function recordTelemetry(logger: Logger, t: TokenTelemetry): void {
  logger.info({ telemetry: t }, "token.telemetry");
}

/** Wrap an async op with latency + error-class logging (§25). */
export async function withLatency<T>(
  logger: Logger,
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logger.debug({ op, latencyMs: Date.now() - start }, "op.completed");
    return result;
  } catch (err) {
    logger.error(
      { op, latencyMs: Date.now() - start, errorClass: (err as Error)?.name ?? "Unknown" },
      "op.failed",
    );
    throw err;
  }
}

export type { Logger };
