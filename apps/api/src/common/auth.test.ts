import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { bearerToken, createTokenVerifier } from "./auth";

const URL_BASE = "https://proj.supabase.co";
const ISSUER = `${URL_BASE}/auth/v1`;
const SECRET = "test-secret-test-secret-test-secret!";
const SUB = "3f2b8c1e-5d4a-4b7e-9c1a-2e6f8a9b0c1d";

function claims(overrides: Record<string, unknown> = {}) {
  return { sub: SUB, email: "Person@Example.com", role: "authenticated", ...overrides };
}

async function hs256(payload: Record<string, unknown>, opts: { secret?: string; issuer?: string; audience?: string; exp?: string } = {}) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? "authenticated")
    .setExpirationTime(opts.exp ?? "5m")
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

describe("createTokenVerifier", () => {
  it("is undefined when nothing is configured to verify against", () => {
    expect(createTokenVerifier({})).toBeUndefined();
  });

  it("accepts a valid HS256 session token and lowercases the email", async () => {
    const verify = createTokenVerifier({ supabaseUrl: URL_BASE, jwtSecret: SECRET, jwks: createLocalJWKSet({ keys: [] }) })!;
    await expect(verify(await hs256(claims()))).resolves.toEqual({ sub: SUB, email: "person@example.com" });
  });

  it("uses only the project origin of SUPABASE_URL", async () => {
    const verify = createTokenVerifier({ supabaseUrl: `${URL_BASE}/rest/v1/`, jwtSecret: SECRET, jwks: createLocalJWKSet({ keys: [] }) })!;
    await expect(verify(await hs256(claims()))).resolves.toEqual({ sub: SUB, email: "person@example.com" });
  });

  it("rejects a wrong signature, issuer, audience, or an expired token", async () => {
    const verify = createTokenVerifier({ supabaseUrl: URL_BASE, jwtSecret: SECRET, jwks: createLocalJWKSet({ keys: [] }) })!;
    await expect(verify(await hs256(claims(), { secret: "another-secret-another-secret-123" }))).rejects.toThrow();
    await expect(verify(await hs256(claims(), { issuer: "https://evil.example/auth/v1" }))).rejects.toThrow();
    await expect(verify(await hs256(claims(), { audience: "anon" }))).rejects.toThrow();
    await expect(verify(await hs256(claims(), { exp: "-1m" }))).rejects.toThrow();
  });

  it("rejects tokens that are not a signed-in user session", async () => {
    const verify = createTokenVerifier({ supabaseUrl: URL_BASE, jwtSecret: SECRET, jwks: createLocalJWKSet({ keys: [] }) })!;
    await expect(verify(await hs256(claims({ role: "service_role" })))).rejects.toThrow("Not a user session token");
    await expect(verify(await hs256(claims({ is_anonymous: true })))).rejects.toThrow("Not a user session token");
    await expect(verify(await hs256(claims({ sub: "admin" })))).rejects.toThrow("no user subject");
    await expect(verify(await hs256(claims({ email: undefined })))).rejects.toThrow("no email");
  });

  it("verifies asymmetric tokens against the JWKS and refuses HS256 without a secret", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] });
    const verify = createTokenVerifier({ supabaseUrl: URL_BASE, jwks })!;
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verify(token)).resolves.toEqual({ sub: SUB, email: "person@example.com" });
    await expect(verify(await hs256(claims()))).rejects.toThrow("HS256 tokens are not accepted");

    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT(claims())
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verify(forged)).rejects.toThrow();
  });
});

describe("bearerToken", () => {
  it("extracts only a well-formed Bearer token", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
