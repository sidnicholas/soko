import type { AgentResult, AgentTask } from "@opportunity-os/contracts";
import { LlmGateway } from "@opportunity-os/llm-gateway";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";

const log = createLogger("worker-agents");
const gateway = LlmGateway.default();

/**
 * §8/§9 — execute a logical agent task through the model-agnostic gateway.
 * Agents only ever return proposed actions; they never mutate money or send
 * outbound messages directly.
 */
export async function runAgentTask(task: AgentTask<{ prompt: string; untrusted?: string }>): Promise<AgentResult<string>> {
  const res = await gateway.run({
    taskClass: "classification",
    prompt: task.input.prompt,
    untrustedContext: task.input.untrusted,
    maxUsd: task.budget.maxUsd,
    timeoutMs: task.budget.deadlineMs,
  });
  return {
    taskId: task.taskId,
    status: "completed",
    output: res.text,
    confidence: 0.6,
    evidenceRefs: [],
    proposedActions: [],
    costTelemetry: res.telemetry,
  };
}

async function main(): Promise<void> {
  getConfig();
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));
  log.info("agent worker started");
  while (running) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5_000);
    await promise;
  }
}

main().catch((err) => {
  log.error({ err: String(err) }, "agent worker crashed");
  process.exitCode = 1;
});
