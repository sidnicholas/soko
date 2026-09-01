import type { Tone } from "@opportunity-os/ui";

/**
 * Collapses a 0..1 risk score (higher = worse) into an operator-facing band.
 * Shared by the opportunities list and detail so the thresholds stay in lockstep.
 */
export function riskBand(score: number): { tone: Tone; label: string } {
  if (score >= 0.66) return { tone: "danger", label: "High" };
  if (score >= 0.33) return { tone: "warning", label: "Medium" };
  return { tone: "success", label: "Low" };
}

/** Tone for a 0..1 desirability score (higher = better) — inverse of {@link riskBand}. */
export function scoreTone(score: number): Tone {
  if (score >= 0.66) return "success";
  if (score >= 0.33) return "warning";
  return "danger";
}
