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

  recordLlm(usd: number): void {
    this.llmCalls++;
    this.llmUsd += usd;
  }
}
