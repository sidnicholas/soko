/**
 * Deterministic decision layer (AIOOS §9, §11, §13-§19, §26). The LLM
 * estimates inputs; this code decides status, score and bucket, so every
 * outcome is reproducible and explainable. Same principle as ADR-015.
 */

export type Label = "source_fact" | "inference" | "estimate" | "unknown";
export type VerificationStatus = "verified" | "strongly_supported" | "plausible" | "speculative" | "rejected";
export type Bucket = "act_now" | "verify_next" | "watch" | "rejected";
export type Urgency = "low" | "medium" | "high";
export type EvidenceStrength = "verified" | "strong" | "plausible" | "speculative" | "none";

export interface ContactPath {
  channel: "marketplace_message" | "email" | "contact_form" | "phone" | "profile" | "procurement_contact" | "unknown";
  value: string | null;
  label: Label;
}

export interface Flag {
  flag: string;
  reason: string;
}

/** Reason codes kept for learning (AIOOS §24). */
export type RejectReason =
  | "stale"
  | "not_credible"
  | "no_counterparty_found"
  | "fraud_risk"
  | "no_value_path"
  /** The "lead" is someone selling services like the user's — a competitor, not a buyer. */
  | "competitor_offer"
  /** Government procurement: needs contractor registration/clearances; screened before paid assessment. */
  | "federal_procurement";

export const RAPID_MODE = {
  /** Experimental revenue target (AIOOS §1) — a yardstick, never a scoring input. */
  revenueTargetUsd: 6000,
  /** Starting capital is ~zero: anything needing more is not ACT NOW material. */
  maxCapitalUsd: 100,
} as const;

// ---------------------------------------------------------------- freshness

const HALF_LIFE_DAYS: Record<Urgency, number> = { high: 3, medium: 14, low: 45 };
/** No publication date: treat as moderately stale until rechecked. */
const UNKNOWN_DATE_FRESHNESS = 0.4;

/** §11 Opportunity decay: exponential in post age, faster for urgent needs. 0..1. */
export function freshnessScore(publishedAt: string | null, urgency: Urgency | null, now: Date = new Date()): number {
  if (!publishedAt) return UNKNOWN_DATE_FRESHNESS;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(publishedAt)) / 86_400_000);
  const halfLife = HALF_LIFE_DAYS[urgency ?? "medium"];
  return round3(Math.pow(0.5, ageDays / halfLife));
}

// ---------------------------------------------------------------- screening

const REGULATORY_PATTERNS: [RegExp, string, string][] = [
  [/\b(freight|truckload|ltl|carrier capacity|load board|dispatch)\b/i, "freight_broker_authority", "Arranging freight for others generally requires FMCSA broker authority."],
  [/\b(real estate|property for sale|commercial lease|land for sale|realtor)\b/i, "real_estate_license", "Brokering real estate for a fee generally requires a license."],
  [/\b(securities|investors?|equity stake|token sale|ico|fund(ing)? round|accredited)\b/i, "securities", "Raising or brokering investments can require securities registration."],
  [/\b(staffing|recruit(ing|er)|placement fee|temp workers)\b/i, "employment_agency_license", "Placing workers for a fee can require an employment-agency license."],
  [/\b(insurance (policy|quote)|underwrit)/i, "insurance_license", "Selling or brokering insurance requires a license."],
  [/\b(pharma|prescription|controlled substance|medical device)\b/i, "medical_pharma_compliance", "Medical/pharmaceutical goods carry FDA/DEA compliance requirements."],
  [/\b(firearm|ammunition|itar|export[- ]controlled|dual[- ]use)\b/i, "controlled_goods", "Controlled goods need licensing/export authorization."],
];

/** §14 Regulatory screening by keyword (in addition to anything the model flagged). */
export function regulatoryFlags(text: string): Flag[] {
  return REGULATORY_PATTERNS.filter(([re]) => re.test(text)).map(([, flag, reason]) => ({ flag, reason }));
}

const FRAUD_PATTERNS: [RegExp, string, string][] = [
  [/\b(wire transfer only|western union|moneygram)\b/i, "unusual_payment", "Insists on hard-to-reverse payment."],
  [/\b(gift cards?)\b.*\b(pay|payment)\b|\b(pay|payment)\b.*\bgift cards?\b/i, "gift_card_payment", "Gift-card payment is a classic scam signal."],
  [/\b(crypto|bitcoin|usdt) only\b/i, "crypto_only", "Cryptocurrency-only payment demand."],
  [/\b(advance fee|upfront fee|processing fee required)\b/i, "advance_fee", "Advance-fee pattern."],
  [/\b(act now|today only|urgent wire|limited time only)\b/i, "pressure_tactics", "Pressure tactics."],
];

/** §15 Fraud screening by keyword (in addition to anything the model flagged). */
export function fraudFlags(text: string): Flag[] {
  return FRAUD_PATTERNS.filter(([re]) => re.test(text)).map(([, flag, reason]) => ({ flag, reason }));
}

export function mergeFlags(...lists: Flag[][]): Flag[] {
  const seen = new Map<string, Flag>();
  for (const f of lists.flat()) if (!seen.has(f.flag)) seen.set(f.flag, f);
  return [...seen.values()];
}

/**
 * Government procurement leads (sam.gov and other .gov/.mil notices) need
 * contractor registration, clearances or the ability to supply directly —
 * every one assessed in live runs was rejected for that. Screened before the
 * paid assessment call.
 */
export function isGovernmentProcurement(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "sam.gov" || h.endsWith(".sam.gov") || h.endsWith(".gov") || h.endsWith(".mil");
}

// ---------------------------------------------------------------- verification

export interface VerificationInput {
  evidence: EvidenceStrength;
  publishedAt: string | null;
  freshness: number;
  contact: ContactPath | null;
  /** An opposite side was actually found (search result or matching service). */
  counterpartyFound: boolean;
}

/**
 * §9 Verification ladder. The model's evidence judgment is an input, but
 * "verified" also needs facts the code can check: a known, recent date and a
 * contact path read from the source itself.
 */
export function verificationStatus(v: VerificationInput): VerificationStatus {
  if (v.evidence === "none") return "rejected";
  if (v.evidence === "speculative" || !v.counterpartyFound) return "speculative";
  const datedAndFresh = v.publishedAt !== null && v.freshness >= 0.5;
  const contactFromSource = v.contact !== null && v.contact.channel !== "unknown" && v.contact.label === "source_fact";
  if (v.evidence === "verified" && datedAndFresh && contactFromSource) return "verified";
  if ((v.evidence === "verified" || v.evidence === "strong") && v.publishedAt !== null) return "strongly_supported";
  return "plausible";
}

// ---------------------------------------------------------------- economics

export type Range = [number, number];

export interface Monetization {
  payer: string | null;
  mechanism: string | null;
  timing: string | null;
  valueAdded: string | null;
}

/** §13 "Why do we get paid?": all of payer, mechanism and value-add must be named. */
export function monetizationResolved(m: Monetization): boolean {
  return Boolean(m.payer?.trim() && m.mechanism?.trim() && m.valueAdded?.trim());
}

function orderRange([a, b]: Range): Range {
  const lo = Math.max(0, Math.min(a, b));
  return [lo, Math.max(lo, Math.max(a, b))];
}

/**
 * §19 Expected value as a range: plausible user compensation × probability of
 * successful execution, decayed by freshness and discounted for fraud risk.
 * Unresolved monetization means no accessible revenue: EV is zero.
 */
export function expectedValue(input: {
  compensationUsd: Range;
  probability: Range;
  freshness: number;
  resolved: boolean;
  fraud: boolean;
}): Range {
  if (!input.resolved) return [0, 0];
  const [cLo, cHi] = orderRange(input.compensationUsd);
  const [pLo, pHi] = orderRange([clamp01(input.probability[0]), clamp01(input.probability[1])]);
  const k = input.freshness * (input.fraud ? 0.3 : 1);
  return [round2(cLo * pLo * k), round2(cHi * pHi * k)];
}

// ---------------------------------------------------------------- score + bucket

export interface ScoreInput {
  ev: Range;
  verification: VerificationStatus;
  freshness: number;
  contact: ContactPath | null;
  resolved: boolean;
  capitalUsd: number;
  timeHours: Range;
  regulatory: Flag[];
  fraud: Flag[];
}

export interface ScoreFactor {
  name: string;
  points: number;
  note: string;
}

const VERIFICATION_POINTS: Record<VerificationStatus, number> = {
  verified: 25,
  strongly_supported: 18,
  plausible: 10,
  speculative: 3,
  rejected: 0,
};

/** §18 Transparent 0-100 score: every point is attributable to a named factor. */
export function scoreCandidate(s: ScoreInput): { score: number; factors: ScoreFactor[] } {
  const evMid = (s.ev[0] + s.ev[1]) / 2;
  // Log-scaled against the experiment target so one huge payoff can't dominate.
  const evPoints = evMid <= 0 ? 0 : Math.min(30, (30 * Math.log10(1 + evMid)) / Math.log10(1 + RAPID_MODE.revenueTargetUsd));
  const factors: ScoreFactor[] = [
    { name: "expected_value", points: evPoints, note: `EV $${s.ev[0]}–$${s.ev[1]} (log-scaled vs $${RAPID_MODE.revenueTargetUsd} target)` },
    { name: "evidence", points: VERIFICATION_POINTS[s.verification], note: `verification: ${s.verification}` },
    { name: "freshness", points: 15 * s.freshness, note: `freshness ${s.freshness}` },
    {
      name: "contactability",
      points: s.contact && s.contact.channel !== "unknown" ? (s.contact.label === "source_fact" ? 10 : 6) : 0,
      note: s.contact ? `${s.contact.channel} (${s.contact.label})` : "no contact path",
    },
    { name: "monetization", points: s.resolved ? 10 : 0, note: s.resolved ? "payer + mechanism named" : "monetization unresolved" },
    {
      name: "speed_and_capital",
      points: (s.capitalUsd <= RAPID_MODE.maxCapitalUsd ? 5 : 0) + (s.timeHours[1] <= 20 ? 5 : s.timeHours[1] <= 60 ? 2 : 0),
      note: `capital $${s.capitalUsd}, ${s.timeHours[0]}–${s.timeHours[1]}h`,
    },
    { name: "regulatory", points: -8 * s.regulatory.length, note: s.regulatory.map((f) => f.flag).join(", ") || "none" },
    { name: "fraud", points: -12 * s.fraud.length, note: s.fraud.map((f) => f.flag).join(", ") || "none" },
  ].map((f) => ({ ...f, points: round2(f.points) }));
  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return { score: round2(score), factors };
}

export interface BucketInput extends ScoreInput {
  compensationHighUsd: number;
  /** The model judged the lead to be a competitor's own offer, not a buyer. */
  competitorOffer?: boolean;
}

/**
 * §26 Action queue placement, with a reason code for every rejection. Order
 * matters for the learning record: the most specific true reason wins, so
 * "no way to get paid" isn't filed as "not credible" (live runs 2026-10-04..06
 * mislabelled most rejections that way).
 */
export function bucketFor(b: BucketInput): { bucket: Bucket; rejectReason: RejectReason | null } {
  if (b.competitorOffer) return { bucket: "rejected", rejectReason: "competitor_offer" };
  if (b.freshness < 0.1) return { bucket: "rejected", rejectReason: "stale" };
  if (b.fraud.length >= 2) return { bucket: "rejected", rejectReason: "fraud_risk" };
  const noValue = !b.resolved || b.compensationHighUsd <= 0;
  if (b.verification === "rejected") return { bucket: "rejected", rejectReason: noValue ? "no_value_path" : "not_credible" };
  if (b.resolved && b.compensationHighUsd <= 0) return { bucket: "rejected", rejectReason: "no_value_path" };
  if (b.verification === "speculative") return { bucket: "watch", rejectReason: null };

  const reachable = b.contact !== null && b.contact.channel !== "unknown";
  const strong = b.verification === "verified" || b.verification === "strongly_supported";
  if (
    b.resolved &&
    strong &&
    reachable &&
    b.freshness >= 0.5 &&
    b.regulatory.length === 0 &&
    b.fraud.length === 0 &&
    b.capitalUsd <= RAPID_MODE.maxCapitalUsd
  ) {
    return { bucket: "act_now", rejectReason: null };
  }
  if (b.resolved && reachable) return { bucket: "verify_next", rejectReason: null };
  // Includes "Potential match — monetization unresolved" (§13).
  return { bucket: "watch", rejectReason: null };
}

export function confidenceFor(verification: VerificationStatus, probability: Range): "low" | "medium" | "high" {
  const spread = Math.abs(probability[1] - probability[0]);
  if ((verification === "verified" || verification === "strongly_supported") && spread <= 0.3) return "high";
  if (verification === "plausible" || verification === "strongly_supported") return "medium";
  return "low";
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
