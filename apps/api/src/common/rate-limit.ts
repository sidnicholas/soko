/**
 * Fixed-window counter per key (PRD v2 §10: inbound rate limiting). In memory,
 * so the limit is per API process: with one `api` instance it is exact, with
 * several it is per instance. Keys whose window has passed are dropped as they
 * are seen, and the whole map is swept once it grows past `maxKeys`, so a flood
 * of distinct senders cannot grow it without bound.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one event for `key`; false once the key is over its limit in the current window. */
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.sweep(t);
      this.windows.set(key, { start: t, count: 1 });
      return this.limit > 0;
    }
    w.count++;
    return w.count <= this.limit;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
