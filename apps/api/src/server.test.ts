import { describe, expect, it } from "vitest";

import { loadPrivateConfig } from "./config/private.js";
import { createAuthenticator } from "./server.js";

const commonEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:placeholder@db.example.test:5432/pih",
  CURSOR_SIGNING_KEY: "fictional-cursor-key-that-is-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.test",
  LOG_LEVEL: "info",
  IDEMPOTENCY_RETENTION_HOURS: "24",
  OUTBOX_RETENTION_DAYS: "7",
  HOST: "127.0.0.1",
  PORT: "3001",
} satisfies NodeJS.ProcessEnv;

describe("server authentication composition", () => {
  it("selects OIDC by default and Tailscale only when explicitly configured", () => {
    const oidc = createAuthenticator(
      loadPrivateConfig({
        ...commonEnvironment,
        OIDC_ISSUER: "https://identity.example.test",
        OIDC_AUDIENCE: "personal-intelligence-hub",
        OIDC_JWKS_URI: "https://identity.example.test/.well-known/jwks.json",
        OIDC_ALLOWED_ALGORITHMS: "RS256",
      }),
      () => new Date("2026-09-25T12:00:00.000Z"),
    );
    const tailscale = createAuthenticator(
      loadPrivateConfig({
        ...commonEnvironment,
        AUTH_MODE: "tailscale",
        PIH_INTERNAL_AUTH_KEY: "fictional-internal-auth-key-at-least-32-bytes",
      }),
      () => new Date("2026-09-25T12:00:00.000Z"),
    );

    expect(oidc.kind).toBe("oidc");
    expect(tailscale.kind).toBe("tailscale");
  });
});
