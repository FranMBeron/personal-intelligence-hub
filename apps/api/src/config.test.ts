import { describe, expect, test } from "vitest";

import { createLoggerOptions } from "./app.js";
import { buildPublicConfig, serializePublicConfig } from "./config/public.js";
import { loadPrivateConfig } from "./config/private.js";
import { redactForLogging } from "./errors.js";

const validEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:placeholder@db.example.test:5432/pih",
  OIDC_ISSUER: "https://identity.example.test",
  OIDC_AUDIENCE: "personal-intelligence-hub",
  OIDC_JWKS_URI: "https://identity.example.test/.well-known/jwks.json",
  OIDC_ALLOWED_ALGORITHMS: "RS256,ES256",
  CURSOR_SIGNING_KEY: "fictional-cursor-key-that-is-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.test,https://admin.example.test",
  LOG_LEVEL: "info",
  IDEMPOTENCY_RETENTION_HOURS: "24",
  OUTBOX_RETENTION_DAYS: "7",
  HOST: "127.0.0.1",
  PORT: "3001",
} satisfies NodeJS.ProcessEnv;

describe("private configuration", () => {
  test("validates and normalizes all server-only settings", () => {
    expect(loadPrivateConfig(validEnvironment)).toEqual({
      nodeEnv: "production",
      databaseUrl: validEnvironment.DATABASE_URL,
      oidcIssuer: validEnvironment.OIDC_ISSUER,
      oidcAudience: validEnvironment.OIDC_AUDIENCE,
      oidcJwksUri: validEnvironment.OIDC_JWKS_URI,
      oidcAlgorithms: ["RS256", "ES256"],
      cursorSigningKey: validEnvironment.CURSOR_SIGNING_KEY,
      allowedOrigins: [
        "https://app.example.test",
        "https://admin.example.test",
      ],
      logLevel: "info",
      idempotencyRetentionHours: 24,
      outboxRetentionDays: 7,
      host: "127.0.0.1",
      port: 3001,
    });
  });

  test("rejects unsafe JWT algorithms and undersized retention windows", () => {
    expect(() =>
      loadPrivateConfig({
        ...validEnvironment,
        OIDC_ALLOWED_ALGORITHMS: "HS256",
      }),
    ).toThrow();
    expect(() =>
      loadPrivateConfig({
        ...validEnvironment,
        IDEMPOTENCY_RETENTION_HOURS: "23",
      }),
    ).toThrow();
    expect(() =>
      loadPrivateConfig({
        ...validEnvironment,
        OUTBOX_RETENTION_DAYS: "6",
      }),
    ).toThrow();
  });
});

describe("public configuration", () => {
  test("serializes only explicitly allow-listed values", () => {
    const sentinel = "PRIVATE_SENTINEL_DO_NOT_SERIALIZE";
    const source = {
      apiVersion: "v1",
      productName: "Personal Intelligence Hub",
      publicOidcIssuer: "https://identity.example.test",
      publicOidcClientId: "pih-web",
      enabledUiCapabilities: ["second-brain", "tasks"],
      databaseUrl: `postgresql://${sentinel}@db.example.test/private`,
      cursorSigningKey: sentinel,
      arbitrarySecret: sentinel,
    };

    const serialized = serializePublicConfig(buildPublicConfig(source));

    expect(JSON.parse(serialized)).toEqual({
      apiVersion: "v1",
      productName: "Personal Intelligence Hub",
      oidcIssuer: "https://identity.example.test",
      oidcClientId: "pih-web",
      enabledUiCapabilities: ["second-brain", "tasks"],
    });
    expect(serialized).not.toContain(sentinel);
  });

  test("redacts authorization, cookies, and secret-shaped config keys", () => {
    const value = {
      authorization: "Bearer private-token",
      headers: { cookie: "session=private", accept: "application/json" },
      config: {
        cursorSigningKey: "private-key",
        databaseUrl: "postgresql://private",
        productName: "Personal Intelligence Hub",
      },
    };

    expect(redactForLogging(value)).toEqual({
      authorization: "[Redacted]",
      headers: { cookie: "[Redacted]", accept: "application/json" },
      config: {
        cursorSigningKey: "[Redacted]",
        databaseUrl: "[Redacted]",
        productName: "Personal Intelligence Hub",
      },
    });
  });

  test("keeps the mandatory redaction policy when configuring a log level", () => {
    const options = createLoggerOptions("warn");

    expect(options.level).toBe("warn");
    expect(options.redact.censor).toBe("[Redacted]");
    expect(options.redact.paths).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.headers.cookie",
        "*.cursorSigningKey",
        "*.databaseUrl",
      ]),
    );
  });
});
