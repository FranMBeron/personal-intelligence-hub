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

describe("private connector configuration", () => {
  const oidcEnvironment = {
    CONNECTORS_ENABLED: "true",
    CONNECTORS_SERVICE_TOKEN: "fictional-connectors-service-token",
    CONNECTORS_DELEGATED_JWT_KEY: "fictional-connectors-delegated-key-at-least-32-bytes",
    CONNECTORS_HUMAN_AUTH_MODE: "oidc",
    CONNECTORS_OIDC_ISSUER: "https://identity.example.test/",
    CONNECTORS_OIDC_AUDIENCE: "fictional-web-audience",
    CONNECTORS_OIDC_JWKS_URI: "https://identity.example.test/jwks",
  };

  it("does not enable connectors or select a default socket unless explicitly enabled", () => {
    expect(loadServerConfig({})).not.toHaveProperty("connectors");
  });

  it("loads the complete OIDC mode and defaults only its private Unix socket", () => {
    expect(loadServerConfig(oidcEnvironment).connectors).toEqual({
      socketPath: "/run/pih-connectors/connectors.sock",
      serviceToken: "fictional-connectors-service-token",
      delegatedJwtKey: "fictional-connectors-delegated-key-at-least-32-bytes",
      humanAuthMode: "oidc",
      oidc: {
        issuer: "https://identity.example.test/",
        audience: "fictional-web-audience",
        jwksUri: "https://identity.example.test/jwks",
      },
    });
  });

  it("loads only the selected Tailscale LocalAPI configuration", () => {
    expect(loadServerConfig({
      CONNECTORS_ENABLED: "true",
      CONNECTORS_SERVICE_TOKEN: "fictional-connectors-service-token",
      CONNECTORS_DELEGATED_JWT_KEY: "fictional-connectors-delegated-key-at-least-32-bytes",
      CONNECTORS_HUMAN_AUTH_MODE: "tailscale-localapi",
      CONNECTORS_SOCKET_PATH: "/run/pih-connectors/connectors.sock",
      CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR: "172.30.0.0/16",
      CONNECTORS_TAILSCALE_LOCALAPI_SOCKET: "/var/run/tailscale/tailscaled.sock",
      CONNECTORS_TAILSCALE_ALLOWED_USERS: "allowed@example.test=a03f7492-09f0-4e8f-95d0-12b7c616aaea",
    }).connectors).toMatchObject({
      humanAuthMode: "tailscale-localapi",
      tailscale: {
        trustedProxyCidr: "172.30.0.0/16",
        localApiSocketPath: "/var/run/tailscale/tailscaled.sock",
        allowedUsers: {
          "allowed@example.test": "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
        },
      },
    });
  });

  it.each([
    { CONNECTORS_ENABLED: "true" },
    { ...oidcEnvironment, CONNECTORS_OIDC_JWKS_URI: undefined },
    { ...oidcEnvironment, CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR: "172.30.0.0/16" },
    { ...oidcEnvironment, CONNECTORS_SOCKET_PATH: "relative.sock" },
    { ...oidcEnvironment, CONNECTORS_OIDC_JWKS_URI: "http://identity.example.test/jwks" },
    {
      ...oidcEnvironment,
      PIH_INTERNAL_AUTH_KEY: "fictional-connectors-delegated-key-at-least-32-bytes",
    },
  ])("rejects partial, mixed-mode, or unsafe connector configuration", (environment) => {
    expect(() => loadServerConfig(environment)).toThrow();
  });

  it("rejects connector settings when the installation has not enabled connectors", () => {
    expect(() => loadServerConfig({
      CONNECTORS_SERVICE_TOKEN: "fictional-connectors-service-token",
    })).toThrow();
  });
});
