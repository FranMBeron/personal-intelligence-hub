import {
  DeviceConnectionIdSchema,
  DeviceConnectionReconnectResultSchema,
  DeviceConnectionStatusSchema,
  SourceStatusSchema,
  type ApiProblem,
  type ApiProblemCode,
  type ConnectorScope,
  type DelegatedPrincipal,
  type DeviceConnectionStatus,
  type SourceStatus,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";

import { requireScope } from "../foundation/auth.js";
import type { ConnectorModule, ConnectorModuleDependencies, ProviderModuleFactory } from "../foundation/module.js";
import { ConnectorProblem, toConnectorProblem } from "../foundation/problems.js";
import {
  DeviceBridgeError,
  createUnixDeviceBridgeClient,
  type DeviceBridgeClient,
  type DeviceBridgeOutcome,
} from "./bridge-client.js";
import type { DeviceConnectionConfig } from "./config.js";

export const DEVICE_CONNECTIONS_SOURCE_ID = "device-connections";
const CAPABILITIES = Object.freeze(["device-connections:status", "device-connections:reconnect"]);
/** Health probes must finish inside the app-wide one second module probe budget. */
const HEALTH_PROBE_TIMEOUT_MS = 800;
/** Bounds simultaneous status exchanges so polling cannot pile up bridge connections. */
const MAX_CONCURRENT_STATUS_REQUESTS = 4;

export type DeviceConnectionsModuleOptions = Readonly<{
  connection?: DeviceConnectionConfig | undefined;
  /** Client used by routes (full status and reconnect timeouts). */
  bridge?: DeviceBridgeClient | undefined;
  /** Client used by the health probe (short status timeout). */
  healthBridge?: DeviceBridgeClient | undefined;
}>;

type RouteFailure = "forbidden" | "not_found" | "validation_failed" | "dependency_unavailable" | "rate_limit_exceeded";

class DeviceRouteError extends Error {
  readonly failure: RouteFailure;

  constructor(failure: RouteFailure) {
    super(failure);
    this.name = "DeviceRouteError";
    this.failure = failure;
  }
}

const FAILURES: Readonly<Record<RouteFailure, Readonly<{ status: number; code: ApiProblemCode; title: string; detail: string }>>> = {
  forbidden: { status: 403, code: "forbidden", title: "Forbidden", detail: "The authenticated connector principal is not allowed." },
  not_found: { status: 404, code: "not_found", title: "Not found", detail: "The requested device connection is not configured." },
  validation_failed: { status: 400, code: "validation_failed", title: "Validation failed", detail: "The request is invalid." },
  dependency_unavailable: {
    status: 503, code: "dependency_unavailable", title: "Dependency unavailable", detail: "The device bridge is temporarily unavailable.",
  },
  rate_limit_exceeded: { status: 429, code: "rate_limit_exceeded", title: "Too many requests", detail: "Please wait before trying again." },
};

const deviceProblem = (error: unknown, requestId: string, instance: string): ApiProblem => {
  const failure = error instanceof DeviceRouteError
    ? error.failure
    : error instanceof DeviceBridgeError ? "dependency_unavailable" : undefined;
  if (failure === undefined) return toConnectorProblem(error, requestId, instance);
  const definition = FAILURES[failure];
  return {
    type: `https://pih.example/problems/${definition.code.replaceAll("_", "-")}`,
    title: definition.title,
    status: definition.status,
    detail: definition.detail,
    instance,
    code: definition.code,
    requestId,
  };
};

const fail = (failure: RouteFailure): never => {
  throw new DeviceRouteError(failure);
};

/**
 * Maps a verified principal to its bridge actor. Only the verified human from the web BFF and
 * allowlisted agent profiles from the agent credential qualify; every other principal is refused.
 * The agent profile is the signed delegated subject, never a request field. Every principal must
 * also act for the configured owner: another authenticated person, or an agent bound to one, is refused.
 */
export const bridgeActorFor = (principal: DelegatedPrincipal, connection: DeviceConnectionConfig): string | undefined => {
  if (principal.actorId.toLowerCase() !== connection.ownerActorId) return undefined;
  if (principal.serviceId === "pih-web" && principal.actorType === "human") return connection.humanActor;
  if (principal.serviceId === "hermes-central" && principal.actorType === "agent") {
    return connection.agentActors.get(principal.subject);
  }
  return undefined;
};

type Authorized = Readonly<{ principal: DelegatedPrincipal; connection: DeviceConnectionConfig; actor: string }>;

type RouteOptions = Readonly<{
  connection: DeviceConnectionConfig | undefined;
  bridge: DeviceBridgeClient | undefined;
  clock: ConnectorModuleDependencies["clock"];
}>;

const deviceConnectionRoutes: FastifyPluginAsync<RouteOptions> = async (app, { connection, bridge, clock }) => {
  let reconnectInFlight = false;
  let statusInFlight = 0;

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const problem = deviceProblem(error, requestId, request.routeOptions.url ?? "/unmatched");
    if (problem.status >= 500) request.log.warn({ code: problem.code, requestId }, "Device connection request failed");
    void reply.status(problem.status).header("x-request-id", requestId).header("cache-control", "no-store")
      .type("application/problem+json").send(problem);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  /** Authorization precedes existence checks, so unauthorized callers learn nothing about ids. */
  const authorize = (request: FastifyRequest, scope: ConnectorScope): Authorized => {
    let principal: DelegatedPrincipal;
    try {
      principal = requireScope(request, scope);
    } catch (error) {
      if (error instanceof ConnectorProblem && error.status === 403) return fail("forbidden");
      throw error;
    }
    if (connection === undefined) {
      if (principal.actorType === "human" || principal.actorType === "agent") return fail("not_found");
      return fail("forbidden");
    }
    const actor = bridgeActorFor(principal, connection);
    if (actor === undefined) return fail("forbidden");
    if (Object.keys(request.query as object).length > 0 || request.body !== undefined) fail("validation_failed");
    const { connectionId } = request.params as { connectionId?: unknown };
    const id = DeviceConnectionIdSchema.safeParse(connectionId);
    if (!id.success || id.data !== connection.id) fail("not_found");
    return { principal, connection, actor };
  };

  const present = (target: DeviceConnectionConfig, outcome: DeviceBridgeOutcome): DeviceConnectionStatus =>
    DeviceConnectionStatusSchema.parse({
      connectionId: target.id,
      label: target.label,
      ...outcome,
      checkedAt: clock.now().toISOString(),
    });

  const audit = (request: FastifyRequest, authorized: Authorized, outcome: string): void => {
    // Content-free: closed codes only; no actor labels, subjects, paths or bridge text.
    request.log.info({
      event: "device_connection_reconnect",
      connectionId: authorized.connection.id,
      serviceId: authorized.principal.serviceId,
      actorType: authorized.principal.actorType,
      outcome,
      requestId: request.id,
    }, "Device connection reconnect");
  };

  app.get("/v1/device-connections/:connectionId", async (request) => {
    const authorized = authorize(request, "devices:read");
    if (bridge === undefined) return fail("dependency_unavailable");
    if (statusInFlight >= MAX_CONCURRENT_STATUS_REQUESTS) return fail("rate_limit_exceeded");
    statusInFlight += 1;
    try {
      return present(authorized.connection, await bridge.status());
    } finally {
      statusInFlight -= 1;
    }
  });

  app.post("/v1/device-connections/:connectionId/reconnect", async (request) => {
    const authorized = authorize(request, "devices:write");
    if (bridge === undefined) return fail("dependency_unavailable");
    if (reconnectInFlight) {
      audit(request, authorized, "in_progress");
      return DeviceConnectionReconnectResultSchema.parse(
        present(authorized.connection, { state: "connecting", reasonCode: "in_progress" }),
      );
    }
    reconnectInFlight = true;
    try {
      const outcome = await bridge.reconnect(authorized.actor);
      audit(request, authorized, outcome.state);
      return DeviceConnectionReconnectResultSchema.parse(present(authorized.connection, outcome));
    } catch (error) {
      audit(request, authorized, error instanceof DeviceBridgeError ? error.code : "error");
      throw error;
    } finally {
      reconnectInFlight = false;
    }
  });
};

const STATE_REASONS = {
  connecting: "device_connecting",
  unavailable: "device_unavailable",
  failed: "device_failed",
} as const;

const sourceStatus = async (
  connection: DeviceConnectionConfig | undefined,
  healthBridge: DeviceBridgeClient | undefined,
  now: () => Date,
): Promise<SourceStatus> => {
  const base = { id: DEVICE_CONNECTIONS_SOURCE_ID, stale: false };
  if (connection === undefined || healthBridge === undefined) {
    return SourceStatusSchema.parse({ ...base, state: "not_configured", checkedAt: now().toISOString(), capabilities: [] });
  }
  try {
    const outcome = await healthBridge.status();
    const checkedAt = now().toISOString();
    if (outcome.state === "connected") {
      return SourceStatusSchema.parse({ ...base, state: "available", checkedAt, lastSuccessAt: checkedAt, capabilities: CAPABILITIES });
    }
    // A sleeping or out-of-range device is normal: degraded, never a readiness failure.
    return SourceStatusSchema.parse({
      ...base, state: "degraded", checkedAt, capabilities: CAPABILITIES, safeReasonCode: STATE_REASONS[outcome.state],
    });
  } catch (error) {
    const safeReasonCode = error instanceof DeviceBridgeError && error.code === "bridge_response_invalid"
      ? "bridge_response_invalid"
      : "bridge_unreachable";
    // The bridge is an optional private companion; its absence is reported, not escalated to readiness.
    return SourceStatusSchema.parse({ ...base, state: "degraded", checkedAt: now().toISOString(), capabilities: [], safeReasonCode });
  }
};

export const createDeviceConnectionsModule = (options: DeviceConnectionsModuleOptions): ConnectorModule =>
  Object.freeze<ConnectorModule>({
    name: DEVICE_CONNECTIONS_SOURCE_ID,
    async register(app: FastifyInstance, dependencies: ConnectorModuleDependencies) {
      await app.register(deviceConnectionRoutes, {
        connection: options.connection,
        bridge: options.bridge,
        clock: dependencies.clock,
      });
    },
    status: (dependencies) => sourceStatus(options.connection, options.healthBridge, () => dependencies.clock.now()),
  });

/** Config-driven factory; registered by the composition root alongside the `devices` namespace. */
export const createDeviceConnectionsProviderModule = (dependencies: ConnectorModuleDependencies): ConnectorModule => {
  const connection = dependencies.config.devices?.connection;
  if (connection === undefined) return createDeviceConnectionsModule({});
  return createDeviceConnectionsModule({
    connection,
    bridge: createUnixDeviceBridgeClient({ socketPath: connection.bridgeSocketPath }),
    healthBridge: createUnixDeviceBridgeClient({
      socketPath: connection.bridgeSocketPath,
      statusTimeoutMs: HEALTH_PROBE_TIMEOUT_MS,
    }),
  });
};

export const deviceConnectionsProviderModule: ProviderModuleFactory = Object.freeze({
  name: DEVICE_CONNECTIONS_SOURCE_ID,
  create: createDeviceConnectionsProviderModule,
});
