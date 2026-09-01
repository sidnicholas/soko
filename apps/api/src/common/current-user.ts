import {
  createParamDecorator,
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { UserRole } from "@opportunity-os/contracts";
import { authorize, type Permission } from "@opportunity-os/auth";

export interface Principal {
  userId: string;
  role: UserRole;
  /** True when the request carries a valid approved-action token (§14). */
  hasApprovedActionToken: boolean;
}

/**
 * Dev auth shim: derives the principal from `x-user-id` / `x-user-role`
 * headers, plus an optional `x-approval-token` for high-impact actions.
 *
 * Production replaces this with Supabase JWT verification (§22): the verified
 * JWT `sub` becomes `userId` and the application-owned role claim becomes
 * `role`. Domain authorization stays application-owned regardless.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const userIdHeader = req.headers["x-user-id"];
  if (typeof userIdHeader !== "string" || userIdHeader.length === 0) {
    throw new UnauthorizedException("Missing x-user-id header");
  }
  const roleHeader = req.headers["x-user-role"];
  const parsedRole = UserRole.safeParse(typeof roleHeader === "string" ? roleHeader : "user");
  if (!parsedRole.success) {
    throw new UnauthorizedException("Invalid x-user-role header");
  }
  const tokenHeader = req.headers["x-approval-token"];
  return {
    userId: userIdHeader,
    role: parsedRole.data,
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
