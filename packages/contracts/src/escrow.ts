import { z } from "zod";
import { zHash, zIso } from "./ids";
import { TrustTier } from "./enums";

/**
 * §19.4/escrow condition engine — a deterministic, versioned DSL for release
 * conditions. A condition is an AND/OR tree of typed predicates evaluated over
 * verified evidence claims. Only the engine decides MILESTONE_PENDING ->
 * MILESTONE_VERIFIED; evidence is data, never instructions.
 */
export const EscrowPredicateType = z.enum([
  "shipment_delivered",
  "document_signed",
  "gps_within_geofence",
  "sensor_threshold",
  "time_elapsed",
  "milestone_attested",
  "oracle_true",
]);
export type EscrowPredicateType = z.infer<typeof EscrowPredicateType>;

export const ThresholdOp = z.enum(["gte", "lte", "eq"]);
export type ThresholdOp = z.infer<typeof ThresholdOp>;

export const EscrowPredicate = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shipment_delivered"), carrier: z.string().optional(), trackingRef: z.string().optional() }),
  z.object({ type: z.literal("document_signed"), documentId: z.string() }),
  z.object({ type: z.literal("gps_within_geofence"), lat: z.number(), lon: z.number(), radiusMeters: z.number().positive() }),
  z.object({ type: z.literal("sensor_threshold"), metric: z.string(), op: ThresholdOp, value: z.number() }),
  z.object({ type: z.literal("time_elapsed"), afterIso: zIso }),
  z.object({ type: z.literal("milestone_attested"), milestoneId: z.string() }),
  z.object({ type: z.literal("oracle_true"), oracleId: z.string() }),
]);
export type EscrowPredicate = z.infer<typeof EscrowPredicate>;

/** AND/OR tree. A leaf pairs a predicate with the minimum evidence trust tier required. */
export type EscrowCondition =
  | { all: EscrowCondition[] }
  | { any: EscrowCondition[] }
  | { predicate: EscrowPredicate; minTrust?: TrustTier };

export const EscrowCondition: z.ZodType<EscrowCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(EscrowCondition) }),
    z.object({ any: z.array(EscrowCondition) }),
    z.object({ predicate: EscrowPredicate, minTrust: TrustTier.optional() }),
  ]),
);

/** A verifier's attestation that some predicate is (or is not) satisfied, ready for the ledger. */
export const EvidenceClaim = z.object({
  verifier: z.string(),
  trustTier: TrustTier,
  predicateType: EscrowPredicateType,
  payload: z.record(z.unknown()).default({}),
  contentHash: zHash,
  sourceUri: z.string().nullable().default(null),
  capturedAt: zIso,
});
export type EvidenceClaim = z.infer<typeof EvidenceClaim>;

export const ReleaseDecision = z.enum(["auto_release", "require_approval", "auto_refund", "hold"]);
export type ReleaseDecision = z.infer<typeof ReleaseDecision>;
