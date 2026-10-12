import { describe, expect, it, vi } from "vitest";

import { TailscaleLocalApiPrincipalResolver } from "./tailscale-localapi-principal";

const config = {
  trustedProxyCidr: "172.30.0.0/16",
  localApiSocketPath: "/var/run/tailscale/tailscaled.sock",
  allowedUsers: { "allowed@example.test": "a03f7492-09f0-4e8f-95d0-12b7c616aaea" },
};
const forwardedRequest = (overrides: {
  peerAddress?: string;
  forwardedFor?: string;
  headers?: Record<string, string>;
} = {}) => ({
  peerAddress: overrides.peerAddress ?? "172.30.0.9",
  headers: new Headers({
    "x-forwarded-for": overrides.forwardedFor ?? "100.64.0.42",
    ...overrides.headers,
  }),
});
const allowedWhoIs = {
  nodeAddresses: ["100.64.0.42/32"],
  loginName: "allowed@example.test",
};

describe("Tailscale LocalAPI verified principal", () => {
  it("ignores spoofed identity headers and trusts WhoIs only", async () => {
    const whoIs = vi.fn(async (socketPath: string, peerIp: string) => {
      expect(socketPath).toBe(config.localApiSocketPath);
      expect(peerIp).toBe("100.64.0.42");
      return allowedWhoIs;
    });
    const resolver = new TailscaleLocalApiPrincipalResolver(config, whoIs);
    await expect(resolver.resolve(forwardedRequest({
      headers: { "tailscale-user-login": "attacker@example.test", "x-forwarded-user": "attacker@example.test" },
    }))).resolves.toEqual({
      ok: true,
      principal: {
        actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
        subject: "tailscale:allowed@example.test",
        actorType: "human",
      },
    });
    expect(whoIs).toHaveBeenCalledTimes(1);
  });

  it("does not derive identity from headers without a trusted immediate peer", async () => {
    const whoIs = vi.fn();
    const resolver = new TailscaleLocalApiPrincipalResolver(config, whoIs);
    await expect(resolver.resolve(forwardedRequest({
      peerAddress: "100.64.0.42",
      headers: { "tailscale-user-login": "allowed@example.test" },
    }))).resolves.toMatchObject({ ok: false });
    await expect(resolver.resolve({ headers: new Headers({
      "x-forwarded-for": "100.64.0.42",
      "tailscale-user-login": "allowed@example.test",
    }) })).resolves.toMatchObject({ ok: false });
    expect(whoIs).not.toHaveBeenCalled();
  });

  it.each([
    "100.64.0.42, 172.30.0.8",
    "100.64.0.42,100.64.0.99",
    "not-an-ip",
    "",
  ])("rejects a malformed or ambiguous forwarded chain: %s", async (forwardedFor) => {
    const whoIs = vi.fn();
    const resolver = new TailscaleLocalApiPrincipalResolver(config, whoIs);
    await expect(resolver.resolve(forwardedRequest({ forwardedFor }))).resolves.toMatchObject({ ok: false });
    expect(whoIs).not.toHaveBeenCalled();
  });

  it("rejects mismatching WhoIs addresses even when identity headers name an allowed user", async () => {
    const resolver = new TailscaleLocalApiPrincipalResolver(config, async () => ({
      nodeAddresses: ["100.64.0.77/32"],
      loginName: "allowed@example.test",
    }));
    await expect(resolver.resolve(forwardedRequest({
      headers: { "tailscale-user-login": "allowed@example.test" },
    }))).resolves.toMatchObject({ ok: false });
  });

  it("rejects unknown users and fails closed when LocalAPI is unavailable", async () => {
    const unknown = new TailscaleLocalApiPrincipalResolver(config, async () => ({
      nodeAddresses: ["100.64.0.42/32"],
      loginName: "unknown@example.test",
    }));
    await expect(unknown.resolve(forwardedRequest())).resolves.toMatchObject({ ok: false, status: 403 });
    const unavailable = new TailscaleLocalApiPrincipalResolver(config, async () => {
      throw new Error("fictional LocalAPI failure");
    });
    await expect(unavailable.resolve(forwardedRequest())).resolves.toMatchObject({ ok: false });
  });
});
