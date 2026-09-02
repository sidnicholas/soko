import type { UserRole } from "@opportunity-os/contracts";

/**
 * §22 — RBAC plus attribute/policy checks. Domain authorization is
 * application-owned even though authentication is delegated to Supabase Auth.
 *
 * Key invariants encoded here (§22 examples):
 *  - an agent can create an ApprovalRequest but cannot approve it;
 *  - a notification worker can deliver approval links but cannot execute settlement;
 *  - a settlement executor requires an approved command with matching payload hash.
 */
export type Permission =
  | "mission:create"
  | "mission:read"
  | "mission:update"
  | "mission:archive"
  | "opportunity:read"
  | "opportunity:reverify"
  | "approval:create"
  | "approval:read"
  | "approval:decide"
  | "negotiation:prepare"
  | "negotiation:send"
  | "transaction:read"
  | "transaction:propose"
  | "settlement:plan"
  | "settlement:execute"
  | "notification:deliver"
  | "signal:submit"
  | "outcome:record"
  | "audit:read";

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  user: ["mission:create", "mission:read", "mission:update", "mission:archive", "opportunity:read", "transaction:read", "signal:submit"],
  operator: [
    "mission:read",
    "opportunity:read",
    "opportunity:reverify",
    "approval:read",
    "approval:decide",
    "negotiation:prepare",
    "transaction:read",
    "transaction:propose",
    "settlement:plan",
    "audit:read",
    "signal:submit",
    "outcome:record",
  ],
  reviewer: ["mission:read", "opportunity:read", "approval:read", "approval:decide", "audit:read"],
  admin: [
    "mission:create",
    "mission:read",
    "mission:update",
    "mission:archive",
    "opportunity:read",
    "opportunity:reverify",
    "approval:create",
    "approval:read",
    "approval:decide",
    "negotiation:prepare",
    "transaction:read",
    "transaction:propose",
    "settlement:plan",
    "settlement:execute",
    "notification:deliver",
    "audit:read",
    "signal:submit",
    "outcome:record",
  ],
  service: ["settlement:execute", "audit:read"],
  // Agents may propose but never approve, send, or move money (§8, §13.5).
  agent: ["opportunity:read", "opportunity:reverify", "approval:create", "negotiation:prepare", "signal:submit"],
};

export function permissionsFor(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface PolicyContextInput {
  role: UserRole;
  /** True when the request carries a valid, unexpired, hash-matched approval token. */
  hasApprovedActionToken?: boolean;
}

/**
 * Attribute layer over RBAC: high-impact actions require both the permission
 * AND a valid approved-action token (§14). No role can self-authorize money.
 */
export function authorize(ctx: PolicyContextInput, permission: Permission): boolean {
  if (!can(ctx.role, permission)) return false;
  if (permission === "settlement:execute" || permission === "negotiation:send" || permission === "transaction:propose") {
    return ctx.hasApprovedActionToken === true;
  }
  return true;
}

export const ROLES: readonly UserRole[] = ["user", "operator", "reviewer", "admin", "service", "agent"];

export * from "./approval-token";
