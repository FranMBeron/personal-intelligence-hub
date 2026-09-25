import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { TailscaleRequestIdentity } from "./tailscale-request-identity";

const signingKey = "fictional-internal-auth-key-at-least-32-bytes";
const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const now = new Date("2026-09-25T12:00:00.000Z");

const createIdentity = () =>
  new TailscaleRequestIdentity({
    allowedUsers: { "owner@example.test": actorId },
    signingKey,
    clock: () => now,
  });

describe("Tailscale request identity", () => {
  it("replaces browser credentials with a short-lived signed internal principal", async () => {
    const resolution = await createIdentity().resolve(
      new Headers({
        authorization: "Bearer forged-browser-token",
        "tailscale-user-login": "Owner@Example.Test",
      }),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected an authorized identity");
    expect(resolution.concurrencyKey).toBe("tailscale:owner@example.test");
    expect(resolution.authorization).not.toContain("forged-browser-token");
    const token = resolution.authorization.replace(/^Bearer /u, "");
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(signingKey),
      {
        algorithms: ["HS256"],
        audience: "personal-intelligence-hub-api",
        issuer: "personal-intelligence-hub-web",
        currentDate: now,
      },
    );

    expect(protectedHeader.alg).toBe("HS256");
    expect(payload).toMatchObject({
      sub: "tailscale:owner@example.test",
      actor_id: actorId,
      actor_type: "human",
      scope: [
        "second-brain:read",
        "second-brain:write",
        "second-brain:compensate",
      ],
      allowed_sources: ["pih"],
      iss: "personal-intelligence-hub-web",
      aud: "personal-intelligence-hub-api",
      iat: 1_790_337_600,
      exp: 1_790_337_630,
    });
  });

  it("distinguishes missing proxy identity from a disallowed user", async () => {
    await expect(createIdentity().resolve(new Headers())).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
    await expect(
      createIdentity().resolve(
        new Headers({ "tailscale-user-login": "outsider@example.test" }),
      ),
    ).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it("rejects ambiguous or malformed proxy identity headers", async () => {
    for (const value of [
      "owner@example.test,outsider@example.test",
      "=?utf-8?q?owner=C3=A9@example.test?=",
    ]) {
      await expect(
        createIdentity().resolve(new Headers({ "tailscale-user-login": value })),
      ).resolves.toMatchObject({ ok: false });
    }
  });
});
// @vitest-environment node
