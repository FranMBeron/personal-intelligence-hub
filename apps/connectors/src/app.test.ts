import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "./config/private.js";
import { createConnectorsApp } from "./app.js";
import type { ConnectorModule } from "./foundation/module.js";
import { openConnectorDatabase } from "./foundation/database.js";
import type { ConnectorDatabase } from "./foundation/database.js";
import { SignJWT } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const web: ServiceCredentialPolicy = {
  serviceId: "pih-web", serviceToken: "test-only-web-credential-000000000000",
  delegatedIssuer: "https://web.test.invalid", delegatedKey: new Uint8Array(32).fill(2),
  actorTypes: ["human"], maxScopes: ["system:read"],
};
const deployer: ServiceCredentialPolicy = {
  serviceId: "pih-deployer", serviceToken: "test-only-deployer-credential-000000",
  delegatedIssuer: "https://deployer.test.invalid", delegatedKey: new Uint8Array(32).fill(3),
  actorTypes: ["service"], maxScopes: ["health:read"],
};
const config: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/connectors-app-test.sqlite",
  serviceCredentials: [web, deployer], audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "Etc/UTC", logLevel: "error",
};
const apps: Awaited<ReturnType<typeof createConnectorsApp>>[] = [];
const databases: ConnectorDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const headers = async (credential: ServiceCredentialPolicy, actorType: "human" | "service", scope: string) => ({
  "x-pih-service-token": credential.serviceToken,
  authorization: "Bearer " + await new SignJWT({ actor_id: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", actor_type: actorType, scope: [scope], request_id: "test-request" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(credential.delegatedIssuer)
    .setAudience(CONNECTORS_AUDIENCE).setSubject("test").setIssuedAt().setExpirationTime("30s")
    .sign(credential.delegatedKey),
});

const makeModule = (name: string, probe: () => Promise<unknown>): ConnectorModule => ({
  name, register: async () => undefined, status: probe as ConnectorModule["status"],
});

const createApp = async (modules: ConnectorModule[] = []) => {
  const directory = await mkdtemp(join(tmpdir(), "pih-connectors-app-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  const app = await createConnectorsApp({
    config, database, clock: { now: () => new Date("2026-10-12T12:00:00.000Z") },
    idGenerator: { generate: () => "test-id" }, modules,
    requestIdFactory: () => "5af093d0-84f1-4759-a92e-bbe2949ab957", logger: false,
  });
  apps.push(app);
  return app;
};

const status = (id: string, state: "available" | "unavailable" = "available") => ({
  id, state, checkedAt: "2026-10-12T12:00:00.000Z", stale: false, capabilities: [],
});

describe("connectors app", () => {
  it("keeps only liveness public and restricts readiness to the deployer", async () => {
    const app = await createApp();
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/health/ready", headers: await headers(web, "human", "system:read") })).statusCode).toBe(403);
    const ready = await app.inject({ method: "GET", url: "/health/ready", headers: await headers(deployer, "service", "health:read") });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready", database: true, migrations: true, modules: true });
    const system = await app.inject({ method: "GET", url: "/v1/system/status", headers: await headers(web, "human", "system:read") });
    expect(system.statusCode).toBe(200);
  });

  it("isolates and sanitizes each invalid or failed provider probe, sorted by module name", async () => {
    const app = await createApp([
      makeModule("zeta", async () => status("zeta")),
      makeModule("calendar", async () => { throw new Error("private provider text"); }),
      makeModule("bad", async () => ({ ...status("bad"), private: true })),
    ]);
    const response = await app.inject({ method: "GET", url: "/v1/system/status", headers: await headers(web, "human", "system:read") });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sources: [{ ...status("bad", "unavailable"), safeReasonCode: "probe_failed" }, { ...status("calendar", "unavailable"), safeReasonCode: "probe_failed" }, status("zeta")] });
    expect(response.body).not.toContain("private provider text");
    expect(response.body).not.toContain("private");
  });

  it("returns the generated request ID with errors and applies the fixed body limit", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: "/v1/preferences", payload: "x".repeat(1_048_577), headers: { ...(await headers(web, "human", "system:read")), "content-type": "application/json" } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "payload_too_large", status: 413 });
    expect(response.headers["x-request-id"]).toBe("5af093d0-84f1-4759-a92e-bbe2949ab957");
  });
});
