/**
 * Hard spend cap (AIOOS §22-§23). Every paid call asks first with an estimate
 * and records the actual cost after; a run stops when the remaining daily
 * allowance can't cover the next call.
 */
export class SpendBudget {
  searchCalls = 0;
  llmCalls = 0;
  searchUsd = 0;
  llmUsd = 0;
  /** Calls and spend per stage and model ("detection", "openrouter/deepseek/…"), for the run's notes. */
  readonly models: Record<string, { calls: number; usd: number }> = {};

  constructor(private readonly remainingUsd: number) {}

  get spentUsd(): number {
    return this.searchUsd + this.llmUsd;
  }

  canSpend(estimateUsd: number): boolean {
    return this.spentUsd + estimateUsd <= this.remainingUsd + 1e-9;
  }

  recordSearch(usd: number): void {
    this.searchCalls++;
    this.searchUsd += usd;
  }

  recordLlm(usd: number, by?: { stage: string; provider?: string; model?: string }): void {
    this.llmCalls++;
    this.llmUsd += usd;
    if (by) {
      const key = `${by.stage}:${by.provider ?? "unknown"}/${by.model ?? "unknown"}`;
      const m = (this.models[key] ??= { calls: 0, usd: 0 });
      m.calls++;
      m.usd = Math.round((m.usd + usd) * 1e6) / 1e6;
    }
  }
}
