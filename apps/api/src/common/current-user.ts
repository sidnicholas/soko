import {
  createParamDecorator,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { UserRole } from "@opportunity-os/contracts";
import { authorize, type Permission } from "@opportunity-os/auth";
import type { AuthenticatedRequest } from "./auth.guard";

export interface Principal {
  userId: string;
  role: UserRole;
  /** Present for a verified sign-in; absent under the local dev-header shim. */
  email?: string;
  /** True when the request carries a valid approved-action token (§14). */
  hasApprovedActionToken: boolean;
}

/**
 * The caller authenticated by the global `AuthGuard` (§22): identity from a
 * verified Supabase JWT, role from the application-owned `users` row. Throws
 * 401 when the request carries no valid credentials. An optional
 * `x-approval-token` rides along for high-impact actions.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.authUser) {
    throw new UnauthorizedException(req.authError ?? "Authentication required");
  }
  const tokenHeader = req.headers["x-approval-token"];
  return {
    ...req.authUser,
    hasApprovedActionToken: typeof tokenHeader === "string" && tokenHeader.length > 0,
  };
});

/** Extracts the raw `x-approval-token` header (verified cryptographically per action). */
export const ApprovalToken = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const header = req.headers["x-approval-token"];
  return typeof header === "string" && header.length > 0 ? header : undefined;
});

/** Enforces an application-owned permission for the principal (§22); throws 403. */
export function requirePermission(principal: Principal, permission: Permission): void {
  const allowed = authorize(
    { role: principal.role, hasApprovedActionToken: principal.hasApprovedActionToken },
    permission,
  );
  if (!allowed) {
    throw new ForbiddenException(`Role '${principal.role}' lacks permission '${permission}'`);
  }
}
