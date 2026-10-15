import { getConfig } from "@opportunity-os/config";
import { closeDb, getDb, relayOutboxBatch } from "@opportunity-os/db";
import { createLogger, type Logger } from "@opportunity-os/observability";
import { LogPublisher, RedisPublisher, type EventPublisher } from "./publisher";

const POLL_INTERVAL_MS = 2000;

/**
 * §10/§550 transactional-outbox relay. Publishes the oldest unpublished events
 * then marks them published, guaranteeing DB state and the event stream never
 * diverge. Rows are locked while a batch runs, so two relays never publish the
 * same event. Exported so it can be driven once (CLI `--once`) or in a loop.
 */
export async function runRelayOnce(publisher: EventPublisher, batchSize = 100): Promise<number> {
  return relayOutboxBatch(getDb(), (envelope) => publisher.publish(envelope), batchSize);
}

function makePublisher(log: Logger): EventPublisher {
  if ((process.env.OUTBOX_PUBLISHER ?? "log") === "redis") return new RedisPublisher(getConfig().redis.url);
  return new LogPublisher(log);
}

async function main(): Promise<void> {
  const log = createLogger("worker-outbox");
  const once = process.argv.includes("--once");
  const publisher = makePublisher(log);
  let running = true;
  process.on("SIGINT", () => (running = false));
  process.on("SIGTERM", () => (running = false));

  log.info({ publisher: publisher.name, once }, "outbox relay started");

  if (once) {
    const published = await runRelayOnce(publisher);
    log.info({ published }, "relay once complete");
    await publisher.close();
    await closeDb();
    return;
  }

  while (running) {
    try {
      const published = await runRelayOnce(publisher);
      if (published > 0) log.info({ published }, "relay batch published");
    } catch (err) {
      log.error({ err: String(err) }, "relay batch failed");
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, POLL_INTERVAL_MS);
    await promise;
  }

  await publisher.close();
  await closeDb();
}

main().catch((err) => {
  createLogger("worker-outbox").error({ err: String(err) }, "outbox relay crashed");
  process.exit(1);
});
