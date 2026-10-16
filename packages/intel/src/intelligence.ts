import type { Bucket, Flag, RejectReason } from "./rules";

/**
 * Supply and demand intelligence rules (PRD v2 FR-02, FR-03; ADR-038).
 * Deterministic: the model labels what it read, this code decides where a
 * signal goes and how far it may be trusted.
 */

export type Lane = "all" | "demand" | "supply";
export type LeadKind = "demand" | "supply" | "problem";

/** Lead kinds each lane detects, matches and assesses. Problems are demand for services. */
export function laneKinds(lane: Lane): LeadKind[] {
  if (lane === "demand") return ["demand", "problem"];
  if (lane === "supply") return ["supply"];
  return ["demand", "supply", "problem"];
}

/** Stage-1 query orientations a lane searches. */
export function laneOrientations(lane: Lane): string[] {
  return laneKinds(lane);
}

/**
 * Where a detected signal goes. Demand the party did not state itself is a
 * hypothesis on the watchlist, never a lead: a precursor cannot be shown as a
 * buyer (PRD v2 §15). Inferred supply stays a lead, marked inferred.
 */
export function routeSignal(kind: LeadKind, evidenceLevel: "observed" | "inferred"): "lead" | "hypothesis" {
  return kind !== "supply" && evidenceLevel === "inferred" ? "hypothesis" : "lead";
}

const DISTRESSED = /\b(liquidat\w*|salvage|repossess\w*|auction\w*|bankrupt\w*|distressed|closing down|going out of business)\b/i;

/**
 * Liquidation and distressed stock never comes with an assumed clear title
 * (FR-02). Raised as a regulatory-style flag, so it keeps a candidate out of
 * ACT NOW until title is confirmed.
 */
export function titleFlags(lead: { kind: LeadKind; signalType: string | null; titleUnverified: boolean; text: string }): Flag[] {
  if (lead.kind !== "supply") return [];
  if (lead.titleUnverified || lead.signalType === "liquidation" || lead.signalType === "distressed_inventory" || DISTRESSED.test(lead.text)) {
    return [{ flag: "title_unverified", reason: "Liquidation or distressed stock: confirm the seller holds clear title before reselling or brokering it." }];
  }
  return [];
}

/**
 * Inferred signals are capped at WATCH and get no outreach draft: the PRD
 * requires evidence before any outbound claim (FR-03).
 */
export function capForEvidence(
  kind: LeadKind,
  evidenceLevel: "observed" | "inferred",
  decided: { bucket: Bucket; rejectReason: RejectReason | null },
): { bucket: Bucket; rejectReason: RejectReason | null; suppressOutreach: boolean } {
  if (evidenceLevel === "observed") return { ...decided, suppressOutreach: false };
  // Rejected stays rejected with its own reason; anything else is WATCH, labelled inferred first.
  if (decided.bucket === "rejected") return { ...decided, suppressOutreach: true };
  return { bucket: "watch", rejectReason: kind === "supply" ? "surplus_inferred" : "intent_inferred", suppressOutreach: true };
}

/**
 * Economics gates (PRD v2 FR-04) on top of the bucket rules: delivered costs
 * above what the user is paid reject the deal; capital above the per-deal
 * exposure limit holds it at WATCH. A more specific earlier rejection stands.
 */
export function gateByEconomics(
  decided: { bucket: Bucket; rejectReason: RejectReason | null },
  gates: readonly string[],
): { bucket: Bucket; rejectReason: RejectReason | null } {
  if (decided.bucket === "rejected") return decided;
  if (gates.includes("negative_net_economics")) return { bucket: "rejected", rejectReason: "negative_net_economics" };
  if (gates.includes("capital_exposure") && (decided.bucket === "act_now" || decided.bucket === "verify_next")) return { bucket: "watch", rejectReason: "capital_exposure" };
  return decided;
}

/** Days before a counterpart search that found nothing is tried again, and how many tries a lead gets. */
export const COUNTERPART_RETRY_DAYS = 3;
export const MAX_COUNTERPART_ATTEMPTS = 2;

/** Next state of a lead's counterpart search after one attempt. */
export function counterpartOutcome(found: number, attemptsBefore: number, now: Date = new Date()): { status: "found" | "none_found"; nextAt: string | null; attempts: number } {
  const attempts = attemptsBefore + 1;
  if (found > 0) return { status: "found", nextAt: null, attempts };
  const retry = attempts < MAX_COUNTERPART_ATTEMPTS ? new Date(now.getTime() + COUNTERPART_RETRY_DAYS * 86_400_000).toISOString() : null;
  return { status: "none_found", nextAt: retry, attempts };
}

/** A hypothesis is revisited every `revisitDays` and expires after four revisits, within 30–90 days. */
export function hypothesisSchedule(revisitDays: number, now: Date = new Date()): { revisitAt: string; expiresAt: string } {
  const days = Math.min(60, Math.max(3, Math.round(revisitDays)));
  const lifetime = Math.min(90, Math.max(30, days * 4));
  return { revisitAt: new Date(now.getTime() + days * 86_400_000).toISOString(), expiresAt: new Date(now.getTime() + lifetime * 86_400_000).toISOString() };
}
