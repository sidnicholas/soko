/**
 * Consent (PRD v2 FR-06/FR-07): the latest record per channel kind and
 * purpose is in force; an opt-out or refusal always blocks, and nothing is
 * assumed granted. Used by outreach (P2 slice 2) before anything is sent.
 */
export type ConsentStatus = "granted" | "denied" | "opted_out";
export type ConsentPurpose = "outreach" | "call_recording" | "marketing";

export interface ConsentRecord {
  channel_kind: string;
  purpose: string;
  status: string;
  basis: string;
  recorded_at: string;
  expires_at: string | null;
}

/** The consent in force for one channel kind and purpose ("any" records apply to every channel). */
export function consentInForce(records: ConsentRecord[], channelKind: string, purpose: ConsentPurpose, now: Date = new Date()): ConsentRecord | null {
  const applicable = records
    .filter((r) => r.purpose === purpose && (r.channel_kind === channelKind || r.channel_kind === "any"))
    .filter((r) => !r.expires_at || Date.parse(r.expires_at) > now.getTime())
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
  // An opt-out anywhere in force wins over a later grant on the generic channel.
  return applicable.find((r) => r.status === "opted_out") ?? applicable[0] ?? null;
}

export function mayContact(records: ConsentRecord[], channelKind: string, purpose: ConsentPurpose, now: Date = new Date()): { allowed: boolean; reason: string } {
  const c = consentInForce(records, channelKind, purpose, now);
  if (!c) return { allowed: false, reason: "no_consent_recorded" };
  if (c.status !== "granted") return { allowed: false, reason: `consent_${c.status}` };
  return { allowed: true, reason: `granted_${c.basis}` };
}
