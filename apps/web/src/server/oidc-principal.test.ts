import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { OidcPrincipalVerifier } from "./oidc-principal";

const issuer = "https://issuer.example.test/";
const audience = "fictional-web-audience";
const now = new Date("2026-10-12T12:00:00.000Z");
const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";

const createVerifier = async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fictional-key-1";
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const verifier = new OidcPrincipalVerifier({
    issuer,
    audience,
    jwksUri: "https://issuer.example.test/.well-known/jwks.json",
    getKey: jwks,
    clock: () => now,
  });
  const token = async (claims: { issuer?: string; audience?: string; actorId?: string; actorType?: string; expiration?: number } = {}) => new SignJWT({
    actor_id: claims.actorId ?? actorId,
    actor_type: claims.actorType ?? "human",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fictional-key-1" })
    .setSubject("fictional-oidc-subject")
    .setIssuer(claims.issuer ?? issuer)
    .setAudience(claims.audience ?? audience)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(claims.expiration ?? Math.floor(now.getTime() / 1000) + 60)
    .sign(privateKey);
  return { verifier, token };
};

const headersFor = (token: string): Headers => new Headers({
  authorization: `Bearer ${token}`,
  "tailscale-user-login": "spoofed@example.test",
  "x-forwarded-user": "spoofed@example.test",
});

describe("OIDC verified principal", () => {
  it("verifies a test-local JWKS and ignores identity headers", async () => {
    const { verifier, token } = await createVerifier();
    const result = await verifier.resolve(headersFor(await token()));
    expect(result).toEqual({
      ok: true,
      principal: {
        actorId,
        subject: "fictional-oidc-subject",
        actorType: "human",
      },
    });
  });

  it.each([
    { actorType: "service" },
    { actorId: "not-a-uuid" },
    { issuer: "https://other.example.test/" },
    { audience: "personal-intelligence-hub-api" },
    { expiration: Math.floor(now.getTime() / 1000) - 1 },
  ])("fails closed for invalid OIDC identity claims", async (claims) => {
    const { verifier, token } = await createVerifier();
    await expect(verifier.resolve(headersFor(await token(claims)))).resolves.toMatchObject({ ok: false });
  });

  it("rejects absent, malformed, and unsigned bearer tokens", async () => {
    const { verifier } = await createVerifier();
    await expect(verifier.resolve(new Headers())).resolves.toMatchObject({ ok: false, status: 401 });
    await expect(verifier.resolve(new Headers({ authorization: "Basic invalid" }))).resolves.toMatchObject({ ok: false });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "fictional", actor_id: actorId })).toString("base64url")}.`;
    await expect(verifier.resolve(headersFor(unsigned))).resolves.toMatchObject({ ok: false });
  });
});
