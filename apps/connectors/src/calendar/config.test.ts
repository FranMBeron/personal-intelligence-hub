import { describe, expect, it } from "vitest";

import { calendarConfigNamespace } from "./config.js";
import { loadConnectorsConfig } from "../config/private.js";

const bytes = (seed: number): string => Buffer.alloc(32, seed).toString("base64url");
const base = {
  GOOGLE_CALENDAR_CLIENT_ID: "fictional-client.apps.example.test",
  GOOGLE_CALENDAR_CLIENT_SECRET: "fictional-client-secret",
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "https://calendar.example.test/oauth/callback",
  GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS: "300",
  GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS: "900",
  GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS: "3600",
  GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID: "fictional-key-1",
  GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON: JSON.stringify([{ id: "fictional-key-1", key: bytes(1) }]),
  GOOGLE_CALENDAR_BLIND_INDEX_KEY: bytes(2),
};

const foundationEnvironment = (): Record<string, string> => ({
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: "0",
  CONNECTORS_DATABASE_PATH: "/tmp/pih-calendar-test.sqlite",
  CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify([
    ["pih-web", "human", ["calendar:read", "calendar:propose", "calendar:confirm", "calendar:configure"]],
    ["hermes-central", "agent", ["calendar:read", "calendar:propose"]],
    ["telegram-gateway", "service", ["hermes:agents:read"]],
    ["pih-deployer", "service", ["health:read"]],
  ].map(([serviceId, actorType, maxScopes]) => ({
    serviceId, serviceToken: `fictional-token-${serviceId}-012345678901234567890123`,
    delegatedIssuer: `https://issuer.example.test/${serviceId}`,
    delegatedKey: bytes(3), actorTypes: [actorType], maxScopes,
    ...(actorType === "agent" ? { boundActorId: "11111111-1111-4111-8111-111111111111" } : {}),
  }))),
  DEFAULT_TIME_ZONE: "UTC", LOG_LEVEL: "info",
});

describe("Calendar provider configuration", () => {
  it("omits the namespace only when every Calendar setting is absent", () => {
    expect(calendarConfigNamespace.parse({})).toBeUndefined();
  });

  it("rejects partial configuration", () => {
    expect(() => calendarConfigNamespace.parse({ GOOGLE_CALENDAR_CLIENT_ID: base.GOOGLE_CALENDAR_CLIENT_ID })).toThrow();
  });

  it("parses a complete namespace and assigns it through Foundation's extension point", () => {
    const calendar = calendarConfigNamespace.parse(base);
    expect(calendar?.oauthStateTtlSeconds).toBe(300);
    expect(calendar?.activeEncryptionKeyId).toBe("fictional-key-1");
    const config = loadConnectorsConfig({ ...foundationEnvironment(), ...base }, [calendarConfigNamespace]);
    expect(config.calendar?.oauthRedirectUri).toBe(base.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI);
  });

  it.each([
    ["redirect must be HTTPS", { GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "http://calendar.example.test/callback" }],
    ["redirect must not have credentials", { GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "https://user:pass@calendar.example.test/callback" }],
    ["redirect must not have query or fragment", { GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "https://calendar.example.test/callback?x=y" }],
    ["key must decode to 32 bytes", { GOOGLE_CALENDAR_BLIND_INDEX_KEY: Buffer.alloc(31, 1).toString("base64url") }],
    ["active key must exist", { GOOGLE_CALENDAR_ACTIVE_ENCRYPTION_KEY_ID: "missing" }],
    ["key IDs must be unique", { GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON: JSON.stringify([{ id: "fictional-key-1", key: bytes(1) }, { id: "fictional-key-1", key: bytes(2) }]) }],
    ["state TTL lower bound", { GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS: "59" }],
    ["state TTL upper bound", { GOOGLE_CALENDAR_OAUTH_STATE_TTL_SECONDS: "601" }],
    ["proposal TTL bound", { GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS: "1801" }],
    ["proposal TTL pinned below 15 minutes", { GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS: "300" }],
    ["proposal TTL pinned above 15 minutes", { GOOGLE_CALENDAR_PROPOSAL_TTL_SECONDS: "1800" }],
    ["retention TTL bound", { GOOGLE_CALENDAR_RETENTION_INTERVAL_SECONDS: "59" }],
    ["blank client ID", { GOOGLE_CALENDAR_CLIENT_ID: " " }],
  ])("rejects %s", (_label, override) => {
    expect(() => calendarConfigNamespace.parse({ ...base, ...override })).toThrow();
  });

  it("allows HTTP localhost only in test mode", () => {
    expect(calendarConfigNamespace.parse({ ...base, NODE_ENV: "test", GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "http://localhost:3000/callback" })?.oauthRedirectUri).toBe("http://localhost:3000/callback");
    expect(() => calendarConfigNamespace.parse({ ...base, NODE_ENV: "production", GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "http://localhost:3000/callback" })).toThrow();
  });
});
