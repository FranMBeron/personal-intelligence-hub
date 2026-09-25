import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { InvalidTokenError } from "../../application/errors.js";
import { TailscaleInternalAuthenticator } from "./tailscale-internal-authenticator.js";

const signingKey = "fictional-internal-auth-key-at-least-32-bytes";
const now = new Date("2026-09-25T12:00:00.000Z");
const claims = {
  actor_id: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  actor_type: "human",
  scope: [
    "second-brain:read",
    "second-brain:write",
    "second-brain:compensate",
  ],
  allowed_sources: ["pih"],
} as const;

const sign = async ({
  key = signingKey,
  issuer = "personal-intelligence-hub-web",
  audience = "personal-intelligence-hub-api",
  expiration = Math.floor(now.getTime() / 1_000) + 30,
}: Readonly<{
  key?: string;
  issuer?: string;
  audience?: string;
  expiration?: number;
}> = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("tailscale:owner@example.test")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(expiration)
    .sign(new TextEncoder().encode(key));

const createAuthenticator = () =>
  new TailscaleInternalAuthenticator({ signingKey, clock: () => now });

describe("Tailscale internal authenticator", () => {
  it("returns the signed framework-free principal", async () => {
    const authenticator = createAuthenticator();

    await expect(authenticator.authenticate(await sign())).resolves.toEqual({
      subject: "tailscale:owner@example.test",
      actorId: claims.actor_id,
      actorType: "human",
      scopes: [...claims.scope],
      allowedSources: ["pih"],
    });
    expect(authenticator.kind).toBe("tailscale");
  });

  it.each([
    ["wrong key", () => sign({ key: "another-fictional-key-that-is-long-enough" })],
    ["wrong issuer", () => sign({ issuer: "forged-web" })],
    ["wrong audience", () => sign({ audience: "some-other-api" })],
    [
      "expired token",
      () => sign({ expiration: Math.floor(now.getTime() / 1_000) - 1 }),
    ],
    [
      "overlong lifetime",
      () => sign({ expiration: Math.floor(now.getTime() / 1_000) + 3_600 }),
    ],
  ])("rejects a token with %s", async (_label, tokenFactory) => {
    await expect(
      tokenFactory().then((token) => createAuthenticator().authenticate(token)),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
