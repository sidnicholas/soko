import { createHash } from "node:crypto";
import type { EscrowPredicateType, EvidenceClaim, TrustTier } from "@opportunity-os/contracts";

/**
 * §escrow — evidence verifier adapters. Mirrors connectors-sdk: pluggable,
 * source-tagged, deterministic. A verifier turns a raw attestation into a
 * trust-tiered, content-hashed EvidenceClaim, or null if it cannot vouch for it.
 * Local reference implementations run with no external keys (keyless-testable);
 * production verifiers (carrier APIs, e-sign, oracles) implement the same shape.
 */
export interface RawEvidence {
  predicateType: EscrowPredicateType;
  payload: Record<string, unknown>;
  sourceUri?: string | null;
}

export interface EvidenceVerifier {
  readonly id: string;
  readonly trustTier: TrustTier;
  /** Predicate types this verifier can attest. */
  readonly handles: readonly EscrowPredicateType[];
  verify(raw: RawEvidence, now?: Date): EvidenceClaim | null;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v !== undefined) out[k] = canonicalize(v);
  }
  return out;
}

export function hashEvidence(predicateType: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize({ predicateType, payload })), "utf8").digest("hex");
}

function claim(
  verifier: EvidenceVerifier,
  raw: RawEvidence,
  payload: Record<string, unknown>,
  now: Date,
): EvidenceClaim {
  return {
    verifier: verifier.id,
    trustTier: verifier.trustTier,
    predicateType: raw.predicateType,
    payload,
    contentHash: hashEvidence(raw.predicateType, payload),
    sourceUri: raw.sourceUri ?? null,
    capturedAt: now.toISOString(),
  };
}

/**
 * Manual attestation verifier — an operator (or trusted service) asserts a
 * predicate holds. Lowest programmatic trust; a human is in the loop. Handles
 * every predicate type so any milestone can be attested when no automated
 * verifier exists yet.
 */
export function makeAttestationVerifier(
  id = "local-attestation",
  trustTier: TrustTier = "basic",
): EvidenceVerifier {
  const handles: EscrowPredicateType[] = [
    "shipment_delivered",
    "document_signed",
    "gps_within_geofence",
    "sensor_threshold",
    "time_elapsed",
    "milestone_attested",
    "oracle_true",
  ];
  const self: EvidenceVerifier = {
    id,
    trustTier,
    handles,
    verify(raw, now = new Date()) {
      // An attestation must positively assert the claim.
      if (raw.payload["attested"] !== true) return null;
      return claim(self, raw, raw.payload, now);
    },
  };
  return self;
}

/**
 * Deterministic e-signature verifier: accepts a document_signed attestation
 * only when payload.signature equals HMAC-like proof over the documentId.
 * Keyless-testable (the "secret" is injected); higher trust than attestation.
 */
export function makeSignedDocumentVerifier(secret: string, id = "local-esign"): EvidenceVerifier {
  const self: EvidenceVerifier = {
    id,
    trustTier: "verified",
    handles: ["document_signed"],
    verify(raw, now = new Date()) {
      const documentId = raw.payload["documentId"];
      const signature = raw.payload["signature"];
      if (typeof documentId !== "string" || typeof signature !== "string") return null;
      const expected = createHash("sha256").update(`${secret}:${documentId}`, "utf8").digest("hex");
      if (signature !== expected) return null;
      return claim(self, raw, { documentId, signed: true }, now);
    },
  };
  return self;
}

/** Sign a document the way makeSignedDocumentVerifier expects (test + client helper). */
export function signDocument(secret: string, documentId: string): string {
  return createHash("sha256").update(`${secret}:${documentId}`, "utf8").digest("hex");
}

/** Registry of verifiers keyed by id, indexable by the predicate types they handle. */
export class VerifierRegistry {
  private readonly byId = new Map<string, EvidenceVerifier>();

  register(verifier: EvidenceVerifier): void {
    if (this.byId.has(verifier.id)) throw new Error(`verifier already registered: ${verifier.id}`);
    this.byId.set(verifier.id, verifier);
  }

  get(id: string): EvidenceVerifier | undefined {
    return this.byId.get(id);
  }

  all(): EvidenceVerifier[] {
    return [...this.byId.values()];
  }

  forPredicate(type: EscrowPredicateType): EvidenceVerifier[] {
    return this.all().filter((v) => v.handles.includes(type));
  }
}
