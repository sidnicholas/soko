import { z } from "zod";

/** §22 — application-owned roles layered over Supabase Auth identities. */
export const UserRole = z.enum(["user", "operator", "reviewer", "admin", "service", "agent"]);
export type UserRole = z.infer<typeof UserRole>;

export const UserStatus = z.enum(["active", "suspended", "pending"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const TrustTier = z.enum(["untrusted", "basic", "verified", "trusted"]);
export type TrustTier = z.infer<typeof TrustTier>;

export const MissionStatus = z.enum(["draft", "active", "paused", "archived", "completed"]);
export type MissionStatus = z.infer<typeof MissionStatus>;

/** §3.1(9) availability/lifecycle refresh states shared by demand + supply. */
export const AvailabilityStatus = z.enum(["unknown", "available", "reserved", "unavailable", "expired"]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;

export const Urgency = z.enum(["immediate", "today", "days", "scheduled", "flexible"]);
export type Urgency = z.infer<typeof Urgency>;

export const OpportunityStatus = z.enum([
  "candidate",
  "qualified",
  "awaiting_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "closed",
]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

export const TransactionStatus = z.enum([
  "proposed",
  "agreed",
  "funding",
  "funded",
  "fulfilling",
  "disputed",
  "settled",
  "closed",
  "cancelled",
]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

/** §19 — rail families exposed by the unified settlement abstraction. */
export const RailFamily = z.enum(["fiat", "stablecoin", "onchain_programmable"]);
export type RailFamily = z.infer<typeof RailFamily>;

/** §20 — progressive settlement state machine. */
export const SettlementStatus = z.enum([
  "DRAFT",
  "AWAITING_FUNDING_APPROVAL",
  "FUNDING_PENDING",
  "FUNDED",
  "MILESTONE_PENDING",
  "MILESTONE_VERIFIED",
  "AWAITING_RELEASE_APPROVAL",
  "RELEASE_PENDING",
  "PARTIALLY_SETTLED",
  "DISPUTED",
  "FROZEN",
  "REFUNDED",
  "SETTLED",
]);
export type SettlementStatus = z.infer<typeof SettlementStatus>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "modified", "expired", "review"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalDecision = z.enum(["approve", "reject", "modify", "review"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ActorType = z.enum(["user", "operator", "agent", "service", "system"]);
export type ActorType = z.infer<typeof ActorType>;

/** §9 — logical agent taxonomy mapped onto domain capabilities. */
export const AgentType = z.enum([
  "demand",
  "collector",
  "classification",
  "scoring",
  "matching",
  "research",
  "risk",
  "negotiation",
  "transaction",
  "logistics",
  "crm",
  "portfolio",
  "learning",
  "orchestrator",
  "lifecycle",
  "approval",
]);
export type AgentType = z.infer<typeof AgentType>;

export const PaymentMethodFamily = z.enum(["card", "ach", "wire", "stablecoin", "onchain", "cash", "other"]);
export type PaymentMethodFamily = z.infer<typeof PaymentMethodFamily>;

export const ConnectorCapability = z.enum(["demand", "supply", "availability", "pricing"]);
export type ConnectorCapability = z.infer<typeof ConnectorCapability>;

/** §13.1 category gate. */
export const CategoryPolicy = z.enum(["allowed", "review_required", "prohibited_for_v1"]);
export type CategoryPolicy = z.infer<typeof CategoryPolicy>;

/**
 * §19/crypto-asset expansion — non-fungible/position asset classes that move
 * as a distinct object or position rather than a fungible Money amount.
 * Deliberately open-ended on kind, not on legality: the risk category gate
 * (@opportunity-os/risk `CATEGORY_POLICY`) still decides per-category what's
 * actually transactable.
 */
export const AssetKind = z.enum(["nft", "defi_position", "data_feed_subscription", "synthetic_position"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetTransferStatus = z.enum(["pending", "confirmed", "failed", "reclaimed"]);
export type AssetTransferStatus = z.infer<typeof AssetTransferStatus>;

export const CounterpartyType = z.enum(["person", "organization"]);
export type CounterpartyType = z.infer<typeof CounterpartyType>;

export const NegotiationSide = z.enum(["buy", "sell"]);
export type NegotiationSide = z.infer<typeof NegotiationSide>;

export const NegotiationState = z.enum(["draft", "proposed", "countered", "accepted", "rejected", "expired"]);
export type NegotiationState = z.infer<typeof NegotiationState>;

/** Mission-level autonomy ceiling. maySend is false by default in V1 (§7). */
export const AutonomyPolicy = z.enum(["discover_only", "prepare_negotiation", "full_prepare"]);
export type AutonomyPolicy = z.infer<typeof AutonomyPolicy>;

/** Ingestion channel a raw signal arrived on (§ multi-channel discovery). */
export const SignalChannel = z.enum([
  "public_web",
  "official_api",
  "browser_extension",
  "user_submitted",
  "merchant_feed",
  "request_mining",
  "internal",
  "telegram",
  "sms",
  "email",
  "whatsapp",
]);
export type SignalChannel = z.infer<typeof SignalChannel>;

export const SignalKind = z.enum(["supply", "demand"]);
export type SignalKind = z.infer<typeof SignalKind>;

export const SignalStatus = z.enum(["captured", "resolved", "discarded"]);
export type SignalStatus = z.infer<typeof SignalStatus>;

/** Realized result of a pursued opportunity — the learning-loop record. */
export const OutcomeStatus = z.enum(["won", "lost", "expired", "cancelled"]);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;
