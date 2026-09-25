import { describe, expect, it } from "vitest";

import { loadServerConfig } from "./server";

describe("loadServerConfig", () => {
  it("uses the local PIH API default without configuring Hermes", () => {
    expect(loadServerConfig({})).toEqual({
      authMode: "oidc",
      maxUploadBodyBytes: 10_485_760,
      maxConcurrentAgentOperations: 2,
      upstreamTimeoutMs: 5_000,
      agentRequestsPerMinute: 0,
      pihApiInternalUrl: "http://127.0.0.1:3001/",
      publicOrigin: "http://127.0.0.1:3000",
    });
  });

  it("accepts a complete server-only Hermes configuration", () => {
    expect(
      loadServerConfig({
        PIH_API_INTERNAL_URL: "https://api.example.test/base",
        PUBLIC_ORIGIN: "https://pih.example.test",
        HERMES_INTERNAL_URL: "https://hermes.example.test",
        HERMES_SERVICE_TOKEN: "fictional-service-token",
        HERMES_DASHBOARD_URL: "https://dashboard.example.test/hermes",
      }),
    ).toEqual({
      authMode: "oidc",
      maxUploadBodyBytes: 10_485_760,
      maxConcurrentAgentOperations: 2,
      upstreamTimeoutMs: 5_000,
      agentRequestsPerMinute: 0,
      pihApiInternalUrl: "https://api.example.test/base",
      publicOrigin: "https://pih.example.test",
      hermesInternalUrl: "https://hermes.example.test/",
      hermesServiceToken: "fictional-service-token",
      hermesDashboardUrl: "https://dashboard.example.test/hermes",
    });
  });

  it("builds a Tailscale identity configuration from a private allow-list", () => {
    expect(
      loadServerConfig({
        AUTH_MODE: "tailscale",
        PIH_INTERNAL_AUTH_KEY: "fictional-internal-auth-key-at-least-32-bytes",
        TAILSCALE_ALLOWED_USERS:
          "owner@example.test=a03f7492-09f0-4e8f-95d0-12b7c616aaea",
      }),
    ).toMatchObject({
      authMode: "tailscale",
      internalAuthKey: "fictional-internal-auth-key-at-least-32-bytes",
      tailscaleAllowedUsers: {
        "owner@example.test": "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
      },
    });
  });

  it("requires a signing key and allowed user mapping in Tailscale mode", () => {
    expect(() => loadServerConfig({ AUTH_MODE: "tailscale" })).toThrow();
    expect(() =>
      loadServerConfig({
        AUTH_MODE: "tailscale",
        PIH_INTERNAL_AUTH_KEY: "fictional-internal-auth-key-at-least-32-bytes",
        TAILSCALE_ALLOWED_USERS: "invalid-mapping",
      }),
    ).toThrow();
  });

  it("requires Hermes URL and token together", () => {
    expect(() =>
      loadServerConfig({ HERMES_INTERNAL_URL: "https://hermes.example.test" }),
    ).toThrow(/configured together/u);
    expect(() =>
      loadServerConfig({ HERMES_SERVICE_TOKEN: "fictional-service-token" }),
    ).toThrow(/configured together/u);
  });

  it("rejects credentialed or non-HTTP destinations", () => {
    expect(() =>
      loadServerConfig({
        PIH_API_INTERNAL_URL: "https://user:secret@example.test",
      }),
    ).toThrow(/uncredentialed/u);
    expect(() =>
      loadServerConfig({ PIH_API_INTERNAL_URL: "file:///tmp/pih.sock" }),
    ).toThrow(/HTTP\(S\)/u);
    expect(() =>
      loadServerConfig({ PUBLIC_ORIGIN: "https://pih.example.test/path" }),
    ).toThrow(/origin without a path/u);
  });
});
