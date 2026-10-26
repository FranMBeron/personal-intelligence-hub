import { webcrypto } from "node:crypto";

import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { ConnectorsConfig } from "../config/server";
import { deriveRequestContext } from "./context";
import { createConnectorsRequestIdentity } from "./connectors-request-identity";
import type { OidcPrincipalVerifier } from "./oidc-principal";
import { withImmediatePeerAddress, withTrustedProxyPeer } from "./peer-address";

const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const config: ConnectorsConfig = {
  socketPath: "/run/pih-connectors/connectors.sock",
  serviceToken: "fictional-connectors-service-token-at-least-32-bytes",
  delegatedJwtKey: new Uint8Array(32).fill(4),
  humanAuthMode: "tailscale-localapi",
  tailscale: {
    localApiSocketPath: "/var/run/tailscale/tailscaled.sock",
    allowedUsers: { "allowed@example.test": actorId },
  },
};
const signingKey = "fictional-second-brain-internal-key-at-least-32-bytes";
const now = new Date("2026-10-12T12:00:00.000Z");

describe("production connectors identity wiring", () => {
  it("uses the trusted proxy listener and LocalAPI identity before producing a principal", async () => {
    const whoIs = vi.fn(async (_socketPath: string, peerIp: string) => ({
      nodeAddresses: [`${peerIp}/32`],
      loginName: "allowed@example.test",
    }));
    const identity = createConnectorsRequestIdentity(config, signingKey, { whoIs, clock: () => now });
    const context = await withTrustedProxyPeer(() =>
      deriveRequestContext(new Headers({
        "x-forwarded-for": "100.64.0.42",
        "tailscale-user-login": "attacker@example.test",
      }), () => "99acb7b5-9dbe-44bf-a590-00824cfd2893", identity),
    );
    expect(context).toMatchObject({
      ok: true,
      context: {
        principal: { actorId, subject: "tailscale:allowed@example.test", actorType: "human" },
        concurrencyKey: "tailscale:allowed@example.test",
      },
    });
    expect(whoIs).toHaveBeenCalledWith(config.tailscale.localApiSocketPath, "100.64.0.42");
    if (!context.ok) throw new Error("Expected authenticated request context.");
    const verifyKey = await webcrypto.subtle.importKey("raw", Buffer.from(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const { payload } = await jwtVerify(context.context.authorization.slice("Bearer ".length), verifyKey, {
      algorithms: ["HS256"],
      issuer: "personal-intelligence-hub-web",
      audience: "personal-intelligence-hub-api",
      currentDate: now,
    });
    expect(payload).toMatchObject({ actor_id: actorId, sub: "tailscale:allowed@example.test" });
  });

  it("rejects a TCP peer (including loopback) forging the owner's forwarded address", async () => {
    const whoIs = vi.fn(async (_socketPath: string, peerIp: string) => ({
      nodeAddresses: [`${peerIp}/32`],
      loginName: "allowed@example.test",
    }));
    const identity = createConnectorsRequestIdentity(config, signingKey, { whoIs, clock: () => now });
    for (const peer of ["127.0.0.1", "::1", "172.30.0.9", "100.64.0.42"]) {
      await expect(withImmediatePeerAddress(peer, () =>
        deriveRequestContext(new Headers({
          "x-forwarded-for": "100.64.0.42",
          "tailscale-user-login": "allowed@example.test",
        }), () => "99acb7b5-9dbe-44bf-a590-00824cfd2893", identity),
      )).resolves.toMatchObject({ ok: false, problem: { status: 401 } });
    }
    expect(whoIs).not.toHaveBeenCalled();
  });

  it("fails closed without server-captured peer metadata", async () => {
    const whoIs = vi.fn();
    const identity = createConnectorsRequestIdentity(config, signingKey, { whoIs });
    await expect(identity.resolve(new Headers({
      "x-forwarded-for": "100.64.0.42",
      "tailscale-user-login": "allowed@example.test",
    }))).resolves.toMatchObject({ ok: false });
    expect(whoIs).not.toHaveBeenCalled();
  });
});

describe("OIDC connectors identity rate-limit key", () => {
  it("keys concurrency and rate limits on the verified subject, not the bearer token", async () => {
    const principal = { actorId, subject: "fictional-oidc-subject", actorType: "human" as const };
    const oidcVerifier = { resolve: vi.fn(async () => ({ ok: true as const, principal })) } as unknown as OidcPrincipalVerifier;
    const identity = createConnectorsRequestIdentity({
      socketPath: "/run/pih-connectors/connectors.sock",
      serviceToken: "fictional-connectors-service-token-at-least-32-bytes",
      delegatedJwtKey: new Uint8Array(32).fill(4),
      humanAuthMode: "oidc",
      oidc: {
        issuer: "https://identity.example.test/",
        audience: "fictional-audience",
        jwksUri: "https://identity.example.test/jwks",
      },
    }, undefined, { oidcVerifier });
    const first = await identity.resolve(new Headers({ authorization: "Bearer fictional-token-one" }));
    const second = await identity.resolve(new Headers({ authorization: "Bearer fictional-token-two" }));
    expect(first).toMatchObject({ ok: true, concurrencyKey: "oidc:fictional-oidc-subject", principal });
    expect(second).toMatchObject({ ok: true, concurrencyKey: "oidc:fictional-oidc-subject" });
  });
});
