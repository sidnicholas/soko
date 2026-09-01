import { z } from "zod";
import { zIso, zHash } from "./ids";
import { Money } from "./money";
import { GeoLocation } from "./geo";

/** §17 — automation classification. V1 must never build around prohibited scraping. */
export const AutomationMethod = z.enum([
  "official_api",
  "licensed_feed",
  "authorized_user_connection",
  "permitted_public_fetch",
  "manual_human_assisted",
]);
export type AutomationMethod = z.infer<typeof AutomationMethod>;

export const ExternalRef = z.object({
  source_id: z.string(),
  external_id: z.string(),
  uri: z.string().optional(),
});
export type ExternalRef = z.infer<typeof ExternalRef>;

export const ConnectorPolicy = z.object({
  automation: AutomationMethod,
  respects_robots: z.boolean().default(true),
  rate_limit_per_min: z.number().int().positive().optional(),
  allowed_categories: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type ConnectorPolicy = z.infer<typeof ConnectorPolicy>;

export const ConnectorSearch = z.object({
  query: z.string(),
  category: z.string().optional(),
  location: GeoLocation.optional(),
  radiusMiles: z.number().optional(),
  max: z.number().int().positive().default(25),
  filters: z.record(z.unknown()).default({}),
});
export type ConnectorSearch = z.infer<typeof ConnectorSearch>;

/** Raw, untrusted observation as returned by a connector (§13.2). */
export const RawObservation = z.object({
  ref: ExternalRef,
  kind: z.enum(["demand", "supply"]),
  captured_at: zIso,
  content: z.record(z.unknown()),
  content_hash: zHash,
  source_reliability: z.number().min(0).max(1).default(0.5),
  automation: AutomationMethod,
});
export type RawObservation = z.infer<typeof RawObservation>;

export const VerificationResult = z.object({
  ref: ExternalRef,
  still_available: z.boolean(),
  price: Money.optional(),
  verified_at: zIso,
  evidence_hash: zHash.optional(),
});
export type VerificationResult = z.infer<typeof VerificationResult>;
