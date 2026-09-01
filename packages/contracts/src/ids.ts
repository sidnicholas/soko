import { z } from "zod";

/** Canonical identifier (UUID v4 in persistence, opaque string in transit). */
export const zId = z.string().uuid();
export type Id = z.infer<typeof zId>;

/** ISO-8601 timestamp with timezone offset. */
export const zIso = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof zIso>;

/** Lowercase SHA-256 hex digest used across the audit + evidence subsystems. */
export const zHash = z.string().regex(/^[0-9a-f]{64}$/i, "expected a sha-256 hex digest");
export type Hash = z.infer<typeof zHash>;
