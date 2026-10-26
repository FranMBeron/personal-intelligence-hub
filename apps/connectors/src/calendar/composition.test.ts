import { CalendarSourceStatusSchema, ApiProblemSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { createConnectorsApp } from "../app.js";
import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../config/private.js";
import type { ConnectorModuleDependencies } from "../foundation/module.js";
import { closeTestDatabases, openTestDatabase } from "../../test/calendar/fixtures.js";
import type { CalendarRuntimeConfig } from "./config.js";
import { calendarProviderModule } from "./index.js";

afterEach(closeTestDatabases);

const OWNER = "00000000-0000-4000-8000-0000000000b1";
const web: ServiceCredentialPolicy = {
  serviceId: "pih-web", serviceToken: "test-only-pih-web-composition-credential",
  delegatedIssuer: "https://pih-web.test.invalid", delegatedKey: new Uint8Array(32).fill(41),
  actorTypes: ["human"], maxScopes: ["calendar:read", "calendar:configure", "system:read"],
};
const baseConfig: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/calendar-composition-test.sqlite",
  serviceCredentials: [web], audience: CONNECTORS_AUDIENCE, defaultTimeZone: "Etc/UTC", logLevel: "error",
};
const calendarConfig: CalendarRuntimeConfig = {
  googleClientId: "fictional-client-id", googleClientSecret: "fictional-client-secret",
  oauthRedirectUri: "https://pih.example.test/api/ui/v1/calendar/oauth/callback",
  oauthStateTtlSeconds: 600, proposalTtlSeconds: 900, retentionIntervalSeconds: 3_600,
  activeEncryptionKeyId: "fictional-key", encryptionKeys: new Map([["fictional-key", new Uint8Array(32).fill(42)]]),
  blindIndexKey: new Uint8Array(32).fill(43),
};
const headers = async (scope: string) => ({
  "x-pih-service-token": web.serviceToken,
  authorization: "Bearer " + await new SignJWT({ actor_id: OWNER, actor_type: "human", scope: [scope], request_id: "request-fictional" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(web.delegatedIssuer).setAudience(CONNECTORS_AUDIENCE)
    .setSubject("fictional").setIssuedAt().setExpirationTime("30s").sign(web.delegatedKey),
});

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const start = async (config: ConnectorsConfig) => {
  const { db } = await openTestDatabase();
  const dependencies: ConnectorModuleDependencies = {
    config, database: db, clock: { now: () => new Date("2026-10-12T12:00:00.000Z") },
    idGenerator: { generate: () => "00000000-0000-4000-8000-0000000000c1" },
  };
  const module = calendarProviderModule.create(dependencies);
  const app = await createConnectorsApp({ ...dependencies, modules: [module], requestIdFactory: () => "5af093d0-84f1-4759-a92e-bbe2949ab957" });
  apps.push(app);
  return { app, module, dependencies };
};

describe("Calendar provider composition", () => {
  it("serves not_configured without Calendar configuration and refuses configuration routes safely", async () => {
    const { app, module, dependencies } = await start(baseConfig);
    expect(module.name).toBe("calendar");
    await expect(module.status(dependencies)).resolves.toMatchObject({
      id: "calendar", state: "not_configured", safeReasonCode: "provider_not_configured",
    });
    const status = await app.inject({ method: "GET", url: "/v1/calendar/status", headers: await headers("calendar:read") });
    expect(CalendarSourceStatusSchema.parse(status.json())).toMatchObject({ state: "not_configured", canRead: false });
    const refused = await app.inject({ method: "POST", url: "/v1/calendar/oauth/authorizations", headers: await headers("calendar:configure") });
    expect(ApiProblemSchema.parse(refused.json())).toMatchObject({ status: 409, code: "conflict" });
    const system = await app.inject({ method: "GET", url: "/v1/system/status", headers: await headers("system:read") });
    expect(system.json()).toMatchObject({ sources: [{ id: "calendar", state: "not_configured" }] });
  });

  it("composes real services from configuration without provider I/O until a request needs it", async () => {
    const { app, module, dependencies } = await start({ ...baseConfig, calendar: calendarConfig });
    await expect(module.status(dependencies)).resolves.toMatchObject({ id: "calendar", state: "not_configured" });
    const status = await app.inject({ method: "GET", url: "/v1/calendar/status", headers: await headers("calendar:read") });
    expect(CalendarSourceStatusSchema.parse(status.json())).toMatchObject({ state: "not_configured" });
    const authorization = await app.inject({ method: "POST", url: "/v1/calendar/oauth/authorizations", headers: await headers("calendar:configure") });
    expect(authorization.statusCode).toBe(200);
    const url = new URL(authorization.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("fictional-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
