import type { ActorType, ConnectorScope } from "@personal-intelligence-hub/contracts";
import { DeviceConnectionStatusSchema, SourceStatusSchema } from "@personal-intelligence-hub/contracts";
import fastify, { type FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../config/private.js";
import { installConnectorAuthentication } from "../foundation/auth.js";
import type { ConnectorModuleDependencies } from "../foundation/module.js";
import { DeviceBridgeError, type DeviceBridgeClient, type DeviceBridgeOutcome } from "./bridge-client.js";
import type { DeviceConnectionConfig } from "./config.js";
import {
  DEVICE_CONNECTIONS_SOURCE_ID,
  createDeviceConnectionsModule,
  deviceConnectionsProviderModule,
} from "./device-connections-module.js";

const OWNER = "a03f7492-09f0-4e8f-95d0-12b7c616aaea";
const REQUEST_ID = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const NOW = "2026-10-26T12:00:00.000Z";
const SOCKET_PATH = "/run/example-device-bridge/bridge.sock";

const OTHER_ACTOR = "7c1e9a52-61d4-4b0f-8f3a-2d6b9e0c4f11";

type Principal = Readonly<{ service: "web" | "agent" | "gateway"; subject?: string; actorType?: ActorType; actorId?: string; scopes?: readonly ConnectorScope[] }>;

const credential = (
  serviceId: ServiceCredentialPolicy["serviceId"], fill: number, actorTypes: ServiceCredentialPolicy["actorTypes"],
  extra: Partial<ServiceCredentialPolicy> = {},
): ServiceCredentialPolicy => ({
  serviceId,
  serviceToken: "test-only-" + serviceId + "-device-service-token-000000",
  delegatedIssuer: "https://" + serviceId + ".issuer.test.invalid",
  delegatedKey: new Uint8Array(32).fill(fill),
  actorTypes,
  maxScopes: ["devices:read", "devices:write"],
  ...extra,
});

const credentials = {
  web: credential("pih-web", 11, ["human"]),
  agent: credential("hermes-central", 12, ["agent"], { boundActorId: OWNER }),
  gateway: credential("telegram-gateway", 13, ["service"]),
} as const;

const config: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/test-connectors.sqlite",
  serviceCredentials: Object.values(credentials),
  audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "Etc/UTC",
  logLevel: "error",
};

const connection: DeviceConnectionConfig = {
  id: "example-band",
  label: "Example band",
  bridgeSocketPath: SOCKET_PATH,
  humanActor: "owner",
  ownerActorId: OWNER,
  agentActors: new Map([["coordinator", "agent-coordinator"], ["health", "agent-health"]]),
};

const headers = async ({ service, subject = "test-subject", actorType, actorId = OWNER, scopes = ["devices:read", "devices:write"] }: Principal) => {
  const policy = credentials[service];
  return {
    "x-pih-service-token": policy.serviceToken,
    authorization: "Bearer " + await new SignJWT({
      actor_id: actorId, actor_type: actorType ?? policy.actorTypes[0], scope: scopes, request_id: REQUEST_ID,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(policy.delegatedIssuer)
      .setAudience(CONNECTORS_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(policy.delegatedKey),
  };
};

class FakeBridge implements DeviceBridgeClient {
  readonly calls: string[] = [];
  next: () => Promise<DeviceBridgeOutcome> = async () => ({ state: "connected", reasonCode: null });

  status(): Promise<DeviceBridgeOutcome> {
    this.calls.push("status");
    return this.next();
  }

  reconnect(actor: string): Promise<DeviceBridgeOutcome> {
    this.calls.push("reconnect:" + actor);
    return this.next();
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const dependencies = {
  config, clock: { now: () => new Date(NOW) },
} as unknown as ConnectorModuleDependencies;

const createApp = async (configured: DeviceConnectionConfig | null = connection) => {
  const bridge = new FakeBridge();
  const module = createDeviceConnectionsModule({ connection: configured ?? undefined, bridge, healthBridge: bridge });
  const app = fastify({ logger: false });
  apps.push(app);
  installConnectorAuthentication(app, config);
  await module.register(app, dependencies);
  return { app, bridge, module };
};

const get = async (app: FastifyInstance, principal: Principal, url = "/v1/device-connections/example-band") =>
  app.inject({ method: "GET", url, headers: await headers(principal) });
const reconnect = async (app: FastifyInstance, principal: Principal, url = "/v1/device-connections/example-band/reconnect") =>
  app.inject({ method: "POST", url, headers: await headers(principal) });

describe("device connection routes", () => {
  it("relays the bridge status to the verified human without exposing the socket", async () => {
    const { app, bridge } = await createApp();
    bridge.next = async () => ({ state: "connected", reasonCode: null, authenticatedAt: "2026-10-26T11:59:00Z" });

    const response = await get(app, { service: "web" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(DeviceConnectionStatusSchema.parse(response.json())).toEqual({
      connectionId: "example-band", label: "Example band", state: "connected", reasonCode: null,
      authenticatedAt: "2026-10-26T11:59:00Z", checkedAt: NOW,
    });
    expect(response.body).not.toContain(SOCKET_PATH);
    expect(bridge.calls).toEqual(["status"]);
  });

  it("never reports connected when the bridge reports otherwise", async () => {
    const { app, bridge } = await createApp();
    bridge.next = async () => ({ state: "unavailable", reasonCode: "device_unreachable", action: "wake_device" });

    const response = await reconnect(app, { service: "web" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "unavailable", reasonCode: "device_unreachable", action: "wake_device" });
  });

  it("refuses an authenticated human who is not the configured owner without contacting the bridge", async () => {
    const { app, bridge } = await createApp();

    const read = await get(app, { service: "web", actorId: OTHER_ACTOR });
    const write = await reconnect(app, { service: "web", actorId: OTHER_ACTOR });

    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ code: "forbidden" });
    expect(bridge.calls).toEqual([]);
  });

  it("reconnects for the human using the configured human actor", async () => {
    const { app, bridge } = await createApp();

    expect((await reconnect(app, { service: "web" })).statusCode).toBe(200);
    expect(bridge.calls).toEqual(["reconnect:owner"]);
  });

  it.each([["coordinator", "agent-coordinator"], ["health", "agent-health"]])(
    "lets the allowlisted agent profile %s read and reconnect as its bridge actor",
    async (profile, actor) => {
      const { app, bridge } = await createApp();

      expect((await get(app, { service: "agent", subject: profile })).statusCode).toBe(200);
      expect((await reconnect(app, { service: "agent", subject: profile })).statusCode).toBe(200);
      expect(bridge.calls).toEqual(["status", "reconnect:" + actor]);
    },
  );

  it.each(["finance", "constructor", "__proto__", "agent-coordinator"])(
    "refuses the non-allowlisted agent profile %s without contacting the bridge",
    async (profile) => {
      const { app, bridge } = await createApp();

      const read = await get(app, { service: "agent", subject: profile });
      const write = await reconnect(app, { service: "agent", subject: profile });

      expect(read.statusCode).toBe(403);
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ code: "forbidden" });
      expect(bridge.calls).toEqual([]);
    },
  );

  it("refuses service principals even when they hold device scopes", async () => {
    const { app, bridge } = await createApp();

    expect((await get(app, { service: "gateway" })).statusCode).toBe(403);
    expect((await reconnect(app, { service: "gateway" })).statusCode).toBe(403);
    expect(bridge.calls).toEqual([]);
  });

  it("requires the matching device scope", async () => {
    const { app, bridge } = await createApp();

    expect((await get(app, { service: "web", scopes: ["devices:write"] })).statusCode).toBe(403);
    expect((await reconnect(app, { service: "web", scopes: ["devices:read"] })).statusCode).toBe(403);
    expect(bridge.calls).toEqual([]);
  });

  it.each([
    "/v1/device-connections/other-band",
    "/v1/device-connections/Example-Band",
    "/v1/device-connections/%2E%2E",
  ])("returns not found for %s without contacting the bridge", async (url) => {
    const { app, bridge } = await createApp();

    const response = await get(app, { service: "web" }, url);

    // Dot segments may be refused by the router itself; either way nothing reaches the bridge.
    expect(response.statusCode).toBe(404);
    expect(bridge.calls).toEqual([]);
  });

  it("checks authorization before revealing whether a connection exists", async () => {
    const { app } = await createApp();

    expect((await get(app, { service: "agent", subject: "finance" }, "/v1/device-connections/other-band")).statusCode).toBe(403);
  });

  it("rejects query parameters and request bodies", async () => {
    const { app, bridge } = await createApp();
    const withQuery = await get(app, { service: "web" }, "/v1/device-connections/example-band?op=reconnect");
    const withBody = await app.inject({
      method: "POST", url: "/v1/device-connections/example-band/reconnect",
      headers: { ...(await headers({ service: "web" })), "content-type": "application/json" },
      payload: { actor: "owner", command: "restart" },
    });

    expect(withQuery.statusCode).toBe(400);
    expect(withBody.statusCode).toBe(400);
    expect(bridge.calls).toEqual([]);
  });

  it.each(["bridge_unreachable", "bridge_timeout", "bridge_response_invalid"] as const)(
    "maps %s to a sanitized dependency problem",
    async (code) => {
      const { app, bridge } = await createApp();
      bridge.next = async () => { throw new DeviceBridgeError(code); };

      const response = await reconnect(app, { service: "web" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "dependency_unavailable" });
      expect(response.body).not.toContain(code);
      expect(response.body).not.toContain(SOCKET_PATH);
    },
  );

  it("does not start a second reconnect while one is in flight", async () => {
    const { app, bridge } = await createApp();
    let release: (outcome: DeviceBridgeOutcome) => void = () => undefined;
    bridge.next = () => new Promise((resolve) => { release = resolve; });

    const first = reconnect(app, { service: "web" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await reconnect(app, { service: "agent", subject: "health" });
    release({ state: "connected", reasonCode: null });

    expect(second.json()).toMatchObject({ state: "connecting", reasonCode: "in_progress" });
    expect((await first).json()).toMatchObject({ state: "connected" });
    expect(bridge.calls).toEqual(["reconnect:owner"]);
  });

  it("answers not found for every id when no connection is configured", async () => {
    const { app, bridge } = await createApp(null);

    expect((await get(app, { service: "web" })).statusCode).toBe(404);
    expect((await reconnect(app, { service: "web" })).statusCode).toBe(404);
    expect(bridge.calls).toEqual([]);
  });
});

describe("device connection source status", () => {
  const statusFor = async (outcome: () => Promise<DeviceBridgeOutcome>, configured: DeviceConnectionConfig | null = connection) => {
    const bridge = new FakeBridge();
    bridge.next = outcome;
    const module = createDeviceConnectionsModule({ connection: configured ?? undefined, bridge, healthBridge: bridge });
    return SourceStatusSchema.parse(await module.status(dependencies));
  };

  it("reports not_configured without contacting a bridge", async () => {
    await expect(statusFor(async () => { throw new Error("unexpected"); }, null)).resolves.toEqual({
      id: DEVICE_CONNECTIONS_SOURCE_ID, state: "not_configured", checkedAt: NOW, stale: false, capabilities: [],
    });
  });

  it("reports available only when the bridge says connected", async () => {
    await expect(statusFor(async () => ({ state: "connected", reasonCode: null }))).resolves.toMatchObject({
      state: "available", capabilities: ["device-connections:status", "device-connections:reconnect"],
    });
  });

  it.each([
    ["unavailable", "device_unavailable"],
    ["connecting", "device_connecting"],
    ["failed", "device_failed"],
  ] as const)("keeps readiness when the device is %s", async (state, safeReasonCode) => {
    const status = await statusFor(async () => ({ state, reasonCode: null }));
    expect(status).toMatchObject({ state: "degraded", safeReasonCode });
  });

  it("reports an unreachable bridge honestly without failing readiness", async () => {
    const status = await statusFor(async () => { throw new DeviceBridgeError("bridge_unreachable"); });
    expect(status).toMatchObject({ state: "degraded", safeReasonCode: "bridge_unreachable", capabilities: [] });
  });

  it("reports an invalid bridge response distinctly", async () => {
    const status = await statusFor(async () => { throw new DeviceBridgeError("bridge_response_invalid"); });
    expect(status).toMatchObject({ state: "degraded", safeReasonCode: "bridge_response_invalid" });
  });
});

describe("device connection provider factory", () => {
  it("creates an unconfigured module when the namespace is absent", async () => {
    const module = deviceConnectionsProviderModule.create(dependencies);
    expect(deviceConnectionsProviderModule.name).toBe(DEVICE_CONNECTIONS_SOURCE_ID);
    expect(module.name).toBe(DEVICE_CONNECTIONS_SOURCE_ID);
    await expect(module.status(dependencies)).resolves.toMatchObject({ state: "not_configured" });
  });

  it("creates a configured module from the devices namespace", async () => {
    const configured = { ...dependencies, config: { ...config, devices: { connection } } } as ConnectorModuleDependencies;
    const module = deviceConnectionsProviderModule.create(configured);
    // The fictional socket does not exist, so the health probe reports the bridge as unreachable.
    await expect(module.status(configured)).resolves.toMatchObject({ state: "degraded", safeReasonCode: "bridge_unreachable" });
  });
});
