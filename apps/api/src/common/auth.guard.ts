import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { getConfig } from "@opportunity-os/config";
import { UserRole } from "@opportunity-os/contracts";
import { findUserById, provisionUser, UserProvisionError } from "@opportunity-os/db";
import { createLogger } from "@opportunity-os/observability";
import { bearerToken, createTokenVerifier, type TokenVerifier } from "./auth";

/** The authenticated caller, before per-request approval-token state is added. */
export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  email?: string;
}

export type AuthenticatedRequest = FastifyRequest & { authUser?: AuthenticatedUser; authError?: string };

const log = createLogger("auth");

/**
 * §22 — global authentication. Resolves the caller once per request and
 * attaches it to the request; `@CurrentUser()` reads it and throws 401 when
 * absent. The guard itself never rejects, so routes that authenticate another
 * way (provider-signed webhooks, health, public intake) are unaffected.
 *
 * Identity comes from a verified Supabase JWT; the ROLE comes from the
 * application-owned `users` row, never from the token or a header.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly verify: TokenVerifier | undefined;
  private readonly devHeaders: boolean;
  private readonly adminEmails: ReadonlySet<string>;

  constructor() {
    const cfg = getConfig();
    this.verify = createTokenVerifier({ supabaseUrl: cfg.supabase.url, jwtSecret: cfg.supabase.jwtSecret });
    this.devHeaders = cfg.auth.devHeaders;
    this.adminEmails = new Set(cfg.auth.adminEmails);
    if (this.devHeaders) log.warn({}, "auth.dev_headers_enabled — x-user-id / x-user-role are trusted without verification");
    else if (!this.verify) log.error({}, "auth.unconfigured — set SUPABASE_URL (or SUPABASE_JWT_SECRET); every authenticated route will return 401");
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    try {
      req.authUser = await this.authenticate(req);
    } catch (err) {
      req.authError = err instanceof UserProvisionError ? err.message : "Invalid or expired access token";
      if (!(err instanceof UserProvisionError)) log.warn({ err: String(err) }, "auth.token_rejected");
    }
    return true;
  }

  private async authenticate(req: FastifyRequest): Promise<AuthenticatedUser | undefined> {
    const token = bearerToken(req.headers.authorization);
    if (token && this.verify) {
      const identity = await this.verify(token);
      const user =
        (await findUserById(identity.sub)) ??
        (await provisionUser({
          id: identity.sub,
          email: identity.email,
          displayName: identity.email.split("@")[0] ?? identity.email,
          role: this.adminEmails.has(identity.email) ? "admin" : "user",
        }));
      if (user.status !== "active") throw new UserProvisionError("This account is not active");
      return { userId: user.id, role: UserRole.parse(user.role), email: user.email };
    }
    if (this.devHeaders) return devHeaderUser(req);
    return undefined;
  }
}

/** Local-development shim (AUTH_DEV_HEADERS=true): unverified identity from headers. */
function devHeaderUser(req: FastifyRequest): AuthenticatedUser | undefined {
  const userId = req.headers["x-user-id"];
  if (typeof userId !== "string" || userId.length === 0) return undefined;
  const roleHeader = req.headers["x-user-role"];
  const role = UserRole.safeParse(typeof roleHeader === "string" ? roleHeader : "user");
  if (!role.success) throw new Error("Invalid x-user-role header");
  return { userId, role: role.data };
}
