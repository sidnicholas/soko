import type { ReleaseDecision } from "@opportunity-os/contracts";

/** Bumped when release-policy semantics change (auditable decisions). */
export const RELEASE_VERSION = "v1";

export interface ReleaseContext {
  /** Milestone/plan release policy: "always" | "over_threshold" | "never" (legacy strings => always). */
  humanReleasePolicy: string;
  amountMinor: number;
  /** over_threshold cutoff (config). At or above => human release. */
  thresholdMinor: number;
  conditionSatisfied: boolean;
  disputed: boolean;
  now: Date;
  /** Optimistic release: after this instant, release even without full evidence, unless disputed. */
  optimisticAfterIso?: string | null;
  /** Deadman: after this instant with conditions still unmet, auto-refund the buyer. */
  deadmanAtIso?: string | null;
}

export interface ReleaseOutcome {
  version: string;
  decision: ReleaseDecision;
  reason: string;
  /** True when the releasable state came from the optimistic window, not full evidence. */
  optimistic: boolean;
}

function requiresHuman(policy: string, amountMinor: number, thresholdMinor: number): boolean {
  if (policy === "never") return false;
  if (policy === "over_threshold") return amountMinor >= thresholdMinor;
  // "always" and any legacy value default to the safe path.
  return true;
}

/**
 * Decide what happens to a funded milestone. Deterministic + versioned. Order:
 * dispute freezes everything; deadman timeout refunds; otherwise release when
 * conditions are met (or the optimistic window has elapsed) — auto-releasing
 * below the human-control threshold and requiring a human approval above it.
 */
export function decideRelease(ctx: ReleaseContext): ReleaseOutcome {
  if (ctx.disputed) {
    return { version: RELEASE_VERSION, decision: "hold", reason: "disputed", optimistic: false };
  }

  const past = (iso?: string | null): boolean => iso != null && ctx.now.getTime() >= Date.parse(iso);

  if (!ctx.conditionSatisfied && past(ctx.deadmanAtIso)) {
    return { version: RELEASE_VERSION, decision: "auto_refund", reason: "deadman_timeout", optimistic: false };
  }

  let optimistic = false;
  let releasable = ctx.conditionSatisfied;
  if (!releasable && past(ctx.optimisticAfterIso)) {
    releasable = true;
    optimistic = true;
  }
  if (!releasable) {
    return { version: RELEASE_VERSION, decision: "hold", reason: "awaiting_conditions", optimistic: false };
  }

  const decision: ReleaseDecision = requiresHuman(ctx.humanReleasePolicy, ctx.amountMinor, ctx.thresholdMinor)
    ? "require_approval"
    : "auto_release";
  return { version: RELEASE_VERSION, decision, reason: optimistic ? "optimistic_window" : "conditions_met", optimistic };
}
