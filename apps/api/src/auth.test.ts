import type { JWK } from "jose";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { beforeAll, describe, expect, test } from "vitest";

import { OidcJwtAuthenticator } from "./adapters/auth/oidc-jwt-authenticator.js";
import { InvalidTokenError } from "./application/errors.js";

const issuer = "https://identity.example.test";
const audience = "personal-intelligence-hub";
const now = new Date("2026-09-15T12:00:00.000Z");

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
});

const claims = {
  actor_id: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  actor_type: "agent",
  scope: "second-brain:read second-brain:write",
  allowed_sources: ["hermes-web", "test"],
};

const sign = async (
  overrides: {
    issuer?: string;
    audience?: string;
    expiration?: number;
  } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("hermes:test")
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(
      overrides.expiration ?? Math.floor(now.getTime() / 1000) + 300,
    )
    .sign(privateKey);

const makeAuthenticator = () =>
  new OidcJwtAuthenticator({
    issuer,
    audience,
    jwksUri: "https://identity.example.test/.well-known/jwks.json",
    algorithms: ["RS256"],
    keyResolver: createLocalJWKSet({ keys: [jwk] }),
    clock: () => now,
  });

describe("OIDC JWT authenticator", () => {
  test("returns a framework-free principal for a valid JWT", async () => {
    const authenticator = makeAuthenticator();

    await expect(authenticator.authenticate(await sign())).resolves.toEqual({
      subject: "hermes:test",
      actorId: claims.actor_id,
      actorType: "agent",
      scopes: ["second-brain:read", "second-brain:write"],
      allowedSources: ["hermes-web", "test"],
    });
  });

  test.each([
    ["wrong issuer", () => sign({ issuer: "https://forged.example.test" })],
    ["wrong audience", () => sign({ audience: "some-other-api" })],
    [
      "expired token",
      () => sign({ expiration: Math.floor(now.getTime() / 1000) - 1 }),
    ],
  ])("maps a %s to an invalid-token error", async (_label, tokenFactory) => {
    const authenticator = makeAuthenticator();

    await expect(
      tokenFactory().then((token) => authenticator.authenticate(token)),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  test("rejects a trusted token whose algorithm is outside the allow-list", async () => {
    const ecPair = await generateKeyPair("ES256");
    const ecJwk: JWK = {
      ...(await exportJWK(ecPair.publicKey)),
      alg: "ES256",
      kid: "ec-test-key",
      use: "sig",
    };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "ec-test-key" })
      .setSubject("hermes:test")
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
      .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
      .sign(ecPair.privateKey);

    const keyResolver = createLocalJWKSet({ keys: [jwk, ecJwk] });
    const esAllowed = new OidcJwtAuthenticator({
      issuer,
      audience,
      jwksUri: "https://identity.example.test/.well-known/jwks.json",
      algorithms: ["ES256"],
      keyResolver,
      clock: () => now,
    });
    const rsOnly = new OidcJwtAuthenticator({
      issuer,
      audience,
      jwksUri: "https://identity.example.test/.well-known/jwks.json",
      algorithms: ["RS256"],
      keyResolver,
      clock: () => now,
    });

    await expect(esAllowed.authenticate(token)).resolves.toMatchObject({
      subject: "hermes:test",
    });
    await expect(rsOnly.authenticate(token)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});
