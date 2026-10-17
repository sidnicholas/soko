import { createHash } from "node:crypto";

/**
 * Contact channels (PRD v2 FR-06, ADR-041): one normal form per kind, so the
 * same address entered twice is one channel and an opt-out matches it after a
 * purge.
 */
export type ChannelKind = "email" | "phone" | "website" | "marketplace_profile" | "social" | "address" | "other";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The comparable form of a channel value, or null when it is not a valid value of that kind. */
export function normalizeChannel(kind: ChannelKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (kind) {
    case "email": {
      const e = v.toLowerCase().replace(/^mailto:/, "");
      return EMAIL.test(e) ? e : null;
    }
    case "phone": {
      // Digits only, keeping a leading + (E.164-like); too short to be a number is rejected.
      const digits = v.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
      return digits.replace(/\D/g, "").length >= 7 ? digits : null;
    }
    case "website":
    case "marketplace_profile":
    case "social": {
      try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
      } catch {
        return null;
      }
    }
    default:
      return v.toLowerCase().replace(/\s+/g, " ");
  }
}

/** sha256 of kind and normalized value: what is kept of an opted-out channel after a purge. */
export function suppressionHash(kind: ChannelKind, normalized: string): string {
  return createHash("sha256").update(`${kind}\u0000${normalized}`, "utf8").digest("hex");
}
