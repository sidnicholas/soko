import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { getConfig } from "@opportunity-os/config";
import { createLogger } from "@opportunity-os/observability";
import * as activities from "./activities";

const log = createLogger("worker-temporal");

async function main(): Promise<void> {
  const cfg = getConfig();
  const connection = await NativeConnection.connect({ address: cfg.temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: cfg.temporal.namespace,
    taskQueue: cfg.temporal.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
  });

  const shutdown = () => {
    log.info("shutting down temporal worker");
    worker.shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info({ taskQueue: cfg.temporal.taskQueue }, "temporal worker started");
  await worker.run();
  await connection.close();
}

main().catch((err) => {
  log.error({ err: String(err) }, "temporal worker crashed");
  process.exitCode = 1;
});
