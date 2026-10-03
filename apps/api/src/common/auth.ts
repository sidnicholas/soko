import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from "jose";

/** What a verified Supabase access token proves about the caller. */
export interface VerifiedIdentity {
  sub: string;
  email: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export interface TokenVerifierConfig {
  supabaseUrl?: string;
  /** Legacy HS256 shared secret. */
  jwtSecret?: string;
  /** Test seam: overrides the remote JWKS fetched from `supabaseUrl`. */
  jwks?: JWTVerifyGetKey;
}

const ASYMMETRIC_ALGS = ["ES256", "RS256", "EdDSA"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §22 — Supabase access-token verification. Returns undefined when nothing is
 * configured to verify against (the caller then fails closed).
 *
 * The algorithm family is chosen from OUR configuration, never from the token
 * alone: an HS256 token is only accepted when a shared secret is configured,
 * and the JWKS path only accepts asymmetric algorithms — so a token can't
 * downgrade verification by naming a different `alg`.
 */
export function createTokenVerifier(cfg: TokenVerifierConfig): TokenVerifier | undefined {
  // Only the project origin matters; a pasted endpoint URL (e.g. `.../rest/v1/`)
  // would otherwise yield the wrong issuer and JWKS address.
  const base = cfg.supabaseUrl ? new URL(cfg.supabaseUrl).origin : undefined;
  const issuer = base ? `${base}/auth/v1` : undefined;
  const secret = cfg.jwtSecret ? new TextEncoder().encode(cfg.jwtSecret) : undefined;
  const jwks = cfg.jwks ?? (issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : undefined);
  if (!secret && !jwks) return undefined;

  return async (token) => {
    const { alg } = decodeProtectedHeader(token);
    const options = { issuer, audience: "authenticated" };
    let payload;
    if (alg === "HS256") {
      if (!secret) throw new Error("HS256 tokens are not accepted");
      ({ payload } = await jwtVerify(token, secret, { ...options, algorithms: ["HS256"] }));
    } else {
      if (!jwks) throw new Error("No signing keys configured for this token");
      ({ payload } = await jwtVerify(token, jwks, { ...options, algorithms: ASYMMETRIC_ALGS }));
    }
    // The anon/service-role API keys are JWTs from the same issuer; only a
    // signed-in, non-anonymous user session is an identity.
    if (payload.role !== "authenticated" || payload.is_anonymous === true) throw new Error("Not a user session token");
    if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) throw new Error("Token has no user subject");
    if (typeof payload.email !== "string" || payload.email.length === 0) throw new Error("Token has no email");
    return { sub: payload.sub, email: payload.email.toLowerCase() };
  };
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}
