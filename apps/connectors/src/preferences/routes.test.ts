import type { ActorType, ConnectorScope } from "@personal-intelligence-hub/contracts";
import fastify from "fastify";
import { SignJWT } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../config/private.js";
import { installConnectorAuthentication } from "../foundation/auth.js";
import { openConnectorDatabase, type ConnectorDatabase } from "../foundation/database.js";
import { preferencesConnectorModule } from "./routes.js";

const actorId = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const serviceToken = "test-only-pih-web-connector-service-token-000000";
const delegatedKey = new Uint8Array(32).fill(21);
const credential: ServiceCredentialPolicy = {
  serviceId: "pih-web",
  serviceToken,
  delegatedIssuer: "https://pih-web.issuer.test.invalid",
  delegatedKey,
  actorTypes: ["human"],
  maxScopes: ["preferences:read", "preferences:write"],
};
const config: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/test-connectors.sqlite",
  serviceCredentials: [credential],
  audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "America/Argentina/Buenos_Aires",
  logLevel: "error",
};
const apps: ReturnType<typeof fastify>[] = [];
const databases: ConnectorDatabase[] = [];
const directories: string[] = [];

type TokenOptions = { actorId?: string; actorType?: ActorType; scopes?: readonly ConnectorScope[] };
const headers = async ({ actorId: tokenActorId = actorId, actorType = "human", scopes = credential.maxScopes }: TokenOptions = {}) => ({
  "x-pih-service-token": serviceToken,
  authorization: "Bearer " + await new SignJWT({ actor_id: tokenActorId, actor_type: actorType, scope: scopes, request_id: requestId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(credential.delegatedIssuer)
    .setAudience(CONNECTORS_AUDIENCE)
    .setSubject("test-subject")
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(delegatedKey),
});
const createApp = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-preferences-routes-"));
  directories.push(directory);
  const database = openConnectorDatabase(join(directory, "connectors.sqlite"));
  databases.push(database);
  await database.read(() => undefined);
  const app = fastify({ logger: false });
  apps.push(app);
  installConnectorAuthentication(app, config);
  await app.register(preferencesConnectorModule, { config, database });
  return { app, database };
};
const getPreferences = async (app: ReturnType<typeof fastify>) => app.inject({ method: "GET", url: "/v1/preferences", headers: await headers() });
const patchPreferences = async (app: ReturnType<typeof fastify>, body: unknown) => app.inject({ method: "PATCH", url: "/v1/preferences", headers: await headers(), payload: body });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("preferences routes", () => {
  it("returns the installation time zone without inserting a row", async () => {
    const { app, database } = await createApp();

    const response = await getPreferences(app);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ timeZone: "America/Argentina/Buenos_Aires", version: 1 });
    expect(await database.read((db) => db.prepare("SELECT count(*) AS count FROM user_preferences").get<{ count: number }>()?.count)).toBe(0);
  });

  it("returns only the public preference fields after an update", async () => {
    const { app } = await createApp();

    const response = await patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ timeZone: "America/New_York", version: 2 });
    expect(response.body).not.toContain(actorId);
  });

  it("rejects a stale update as a safe version conflict", async () => {
    const { app } = await createApp();
    await patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 });

    const response = await patchPreferences(app, { timeZone: "UTC", expectedVersion: 1 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "version_conflict", status: 409 });
    expect(response.body).not.toContain(actorId);
  });

  it("allows only one of two concurrent first overrides", async () => {
    const { app } = await createApp();

    const responses = await Promise.all([
      patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 }),
      patchPreferences(app, { timeZone: "Etc/UTC", expectedVersion: 1 }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect((await getPreferences(app)).json()).toMatchObject({ version: 2 });
  });

  it("enforces read and write scopes", async () => {
    const { app } = await createApp();
    const readDenied = await app.inject({ method: "GET", url: "/v1/preferences", headers: await headers({ scopes: ["preferences:write"] }) });
    const writeDenied = await app.inject({ method: "PATCH", url: "/v1/preferences", headers: await headers({ scopes: ["preferences:read"] }), payload: { timeZone: "UTC", expectedVersion: 1 } });

    expect(readDenied.statusCode).toBe(403);
    expect(writeDenied.statusCode).toBe(403);
  });
  it("keeps preferences isolated by actor", async () => {
    const { app } = await createApp();
    await patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 });
    const otherActorHeaders = await headers({ actorId: "b03f7492-09f0-4e8f-95d0-12b7c616aaea" });

    const response = await app.inject({ method: "GET", url: "/v1/preferences", headers: otherActorHeaders });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ timeZone: "America/Argentina/Buenos_Aires", version: 1 });
  });

  it("rejects malformed preference updates without writing", async () => {
    const { app, database } = await createApp();
    const badBodies = [
      { timeZone: "UTC", expectedVersion: "2" },
      { timeZone: "Not/A_Zone", expectedVersion: 1 },
      { timeZone: "UTC", expectedVersion: 1, actorId },
    ];

    for (const body of badBodies) {
      const response = await patchPreferences(app, body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "validation_failed", status: 400 });
      expect(response.body).not.toContain(actorId);
    }
    expect(await database.read((db) => db.prepare("SELECT count(*) AS count FROM user_preferences").get<{ count: number }>()?.count)).toBe(0);
  });

  it("rejects a first update whose expected version is not one", async () => {
    const { app } = await createApp();

    const response = await patchPreferences(app, { timeZone: "UTC", expectedVersion: 2 });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "version_conflict", status: 409 });
  });

  it("allows one matching update when two callers race on an existing version", async () => {
    const { app } = await createApp();
    await patchPreferences(app, { timeZone: "America/New_York", expectedVersion: 1 });

    const responses = await Promise.all([
      patchPreferences(app, { timeZone: "Etc/UTC", expectedVersion: 2 }),
      patchPreferences(app, { timeZone: "Europe/Paris", expectedVersion: 2 }),
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect((await getPreferences(app)).json()).toMatchObject({ version: 3 });
  });

  it("normalizes malformed JSON to a safe validation problem", async () => {
    const { app } = await createApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { ...(await headers()), "content-type": "application/json" },
      payload: "{",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed", status: 400 });
    expect(response.body).not.toContain(actorId);
  });

  it("normalizes an empty JSON body to a safe validation problem", async () => {
    const { app } = await createApp();

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers: { ...(await headers()), "content-type": "application/json" },
      payload: "",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "validation_failed", status: 400 });
    expect(response.body).not.toContain(actorId);
  });

});
