import { webcrypto } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import type { VerifiedPrincipal } from "./context";
import { signConnectorsAuthorization } from "./connectors-authorization";

const principal: VerifiedPrincipal = {
  actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  subject: "oidc:fictional-subject",
  actorType: "human",
};
const requestId = "99acb7b5-9dbe-44bf-a590-00824cfd2893";
const delegatedJwtKey = "fictional-connectors-delegated-jwt-key-at-least-32-bytes";
const serviceToken = "fictional-connectors-service-token";
const configuration = { delegatedJwtKey };
const now = new Date("2026-10-12T12:00:00.000Z");

describe("signConnectorsAuthorization", () => {
  it.each([
    ["hermes:conversations:write"],
    ["calendar:read"],
    ["preferences:write"],
  ] as const)("signs exactly the requested operation scope %s", async (scope) => {
    const scopes = [scope];
    const authorization = await signConnectorsAuthorization(principal, requestId, scopes, configuration, () => now);
    expect(authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    const token = authorization.slice("Bearer ".length);
    const signingKey = await webcrypto.subtle.importKey("raw", Buffer.from(delegatedJwtKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const serviceKey = await webcrypto.subtle.importKey("raw", Buffer.from(serviceToken), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      signingKey,
      {
        algorithms: ["HS256"],
        audience: "personal-intelligence-hub-connectors",
        issuer: "personal-intelligence-hub-web",
        currentDate: now,
      },
    );
    expect(protectedHeader).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({
      sub: principal.subject,
      actor_id: principal.actorId,
      actor_type: "human",
      scope: scopes,
      request_id: requestId,
      iss: "personal-intelligence-hub-web",
      aud: "personal-intelligence-hub-connectors",
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 30,
    });
    expect(authorization).not.toContain(serviceToken);
    await expect(jwtVerify(token, serviceKey, {
      audience: "personal-intelligence-hub-connectors",
      issuer: "personal-intelligence-hub-web",
      currentDate: now,
    })).rejects.toThrow();
  });

  it("refuses missing or unverified principals, invalid scopes, and malformed request IDs", async () => {
    await expect(signConnectorsAuthorization(undefined as never, requestId, ["health:read"], configuration)).rejects.toThrow();
    await expect(signConnectorsAuthorization({ ...principal, actorType: "service" } as never, requestId, ["health:read"], configuration)).rejects.toThrow();
    await expect(signConnectorsAuthorization(principal, requestId, ["second-brain:read"] as never, configuration)).rejects.toThrow();
    await expect(signConnectorsAuthorization(principal, "bad-request-id", ["health:read"], configuration)).rejects.toThrow();
  });
});
