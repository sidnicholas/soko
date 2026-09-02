import type { EscrowCondition, EscrowPredicate, EvidenceClaim, TrustTier } from "@opportunity-os/contracts";

/** Bumped whenever evaluation semantics change, so decisions are reproducible + auditable. */
export const CONDITION_VERSION = "v1";

export interface EvaluationResult {
  version: string;
  satisfied: boolean;
  /** Predicates still unmet (for operator visibility + optimistic/deadman logic). */
  missing: EscrowPredicate[];
  /** contentHashes of the evidence claims that satisfied predicates. */
  usedEvidence: string[];
}

const TRUST_RANK: Record<TrustTier, number> = { untrusted: 0, basic: 1, verified: 2, trusted: 3 };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Great-circle distance in metres between two lat/lon points. */
function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Does a single evidence claim satisfy this predicate? Pure + deterministic. */
function claimSatisfies(predicate: EscrowPredicate, claim: EvidenceClaim): boolean {
  if (claim.predicateType !== predicate.type) return false;
  const p = claim.payload;
  switch (predicate.type) {
    case "shipment_delivered":
      if (p["delivered"] !== true) return false;
      return predicate.trackingRef === undefined || p["trackingRef"] === predicate.trackingRef;
    case "document_signed":
      return p["signed"] === true && p["documentId"] === predicate.documentId;
    case "gps_within_geofence": {
      const lat = num(p["lat"]);
      const lon = num(p["lon"]);
      if (lat === null || lon === null) return false;
      return haversineMeters(lat, lon, predicate.lat, predicate.lon) <= predicate.radiusMeters;
    }
    case "sensor_threshold": {
      if (p["metric"] !== predicate.metric) return false;
      const value = num(p["value"]);
      if (value === null) return false;
      if (predicate.op === "gte") return value >= predicate.value;
      if (predicate.op === "lte") return value <= predicate.value;
      return value === predicate.value;
    }
    case "milestone_attested":
      return p["attested"] === true && p["milestoneId"] === predicate.milestoneId;
    case "oracle_true":
      return p["value"] === true && p["oracleId"] === predicate.oracleId;
    case "time_elapsed":
      // Satisfied by the clock, not by evidence (handled in evaluateLeaf).
      return false;
  }
}

function evaluateLeaf(
  predicate: EscrowPredicate,
  minTrust: TrustTier,
  claims: readonly EvidenceClaim[],
  now: Date,
): EvaluationResult {
  if (predicate.type === "time_elapsed") {
    const satisfied = now.getTime() >= Date.parse(predicate.afterIso);
    return { version: CONDITION_VERSION, satisfied, missing: satisfied ? [] : [predicate], usedEvidence: [] };
  }
  const minRank = TRUST_RANK[minTrust];
  const match = claims.find((c) => TRUST_RANK[c.trustTier] >= minRank && claimSatisfies(predicate, c));
  return match
    ? { version: CONDITION_VERSION, satisfied: true, missing: [], usedEvidence: [match.contentHash] }
    : { version: CONDITION_VERSION, satisfied: false, missing: [predicate], usedEvidence: [] };
}

/**
 * Evaluate a release-condition tree over verified evidence claims. Pure,
 * deterministic, versioned: identical inputs always yield an identical result.
 * The only authority that flips a milestone to MILESTONE_VERIFIED.
 */
export function evaluateCondition(
  condition: EscrowCondition,
  claims: readonly EvidenceClaim[],
  now: Date = new Date(),
): EvaluationResult {
  if ("all" in condition) {
    const children = condition.all.map((c) => evaluateCondition(c, claims, now));
    return {
      version: CONDITION_VERSION,
      satisfied: children.every((c) => c.satisfied),
      missing: children.flatMap((c) => c.missing),
      usedEvidence: [...new Set(children.flatMap((c) => c.usedEvidence))],
    };
  }
  if ("any" in condition) {
    const children = condition.any.map((c) => evaluateCondition(c, claims, now));
    const satisfied = children.some((c) => c.satisfied);
    return {
      version: CONDITION_VERSION,
      satisfied,
      missing: satisfied ? [] : children.flatMap((c) => c.missing),
      usedEvidence: [...new Set(children.filter((c) => c.satisfied).flatMap((c) => c.usedEvidence))],
    };
  }
  return evaluateLeaf(condition.predicate, condition.minTrust ?? "basic", claims, now);
}
