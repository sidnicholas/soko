import Redis from "ioredis";
import type { EventEnvelope } from "@opportunity-os/contracts";
import type { Logger } from "@opportunity-os/observability";

/** Where the relay hands off durably-persisted events (§10/§550). */
export interface EventPublisher {
  readonly name: string;
  publish(event: EventEnvelope): Promise<void>;
  close(): Promise<void>;
}

/** Default dev/CI publisher: structured log line per event. */
export class LogPublisher implements EventPublisher {
  readonly name = "log";
  constructor(private readonly log: Logger) {}

  async publish(event: EventEnvelope): Promise<void> {
    this.log.info({ event: event.name, id: event.id, entity: `${event.entity_type}:${event.entity_id}` }, "event.published");
  }

  async close(): Promise<void> {}
}

export const EVENTS_CHANNEL = "opportunity-os.events";

/** Production publisher: fan out on a Redis pub/sub channel. */
export class RedisPublisher implements EventPublisher {
  readonly name = "redis";
  private readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: 3 });
  }

  async publish(event: EventEnvelope): Promise<void> {
    await this.client.publish(EVENTS_CHANNEL, JSON.stringify(event));
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
