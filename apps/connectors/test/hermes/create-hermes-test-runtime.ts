import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import type { ConnectorScope } from "@personal-intelligence-hub/contracts";
import { ApiProblemSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { expect } from "vitest";

import { createConnectorsApp } from "../../src/app.js";
import { CONNECTORS_AUDIENCE } from "../../src/config/private.js";
import { openConnectorDatabase, type ConnectorDatabase, type SqliteHandle } from "../../src/foundation/database.js";
import type { ConnectorModule } from "../../src/foundation/module.js";
import { DELEGATION_PATH } from "../../src/hermes/delegation-server.js";
import { startConnectors } from "../../src/main.js";
import { FakeHermesServer } from "./fake-hermes-server.js";

/**
 * Test-only composition of the real connectors process (configuration loading
 * with every provider namespace, the registered provider module list, the
 * Foundation app, migrations, and the Hermes workers) against a fake Hermes
 * server on an ephemeral loopback port. It goes through `startConnectors`, so
 * Hermes is reached only as `hermesProviderModule` from `providers.ts`; it adds
 * no alternate production composition path. All identities, keys, and tokens
 * are fictional.
 */

export const ORCHESTRATOR_ID = "orchestrator";
export const SPECIALIST_ID = "specialist-a";
export const E2E_ACTOR_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const FOREIGN_ACTOR_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";

const ORCHESTRATOR_KEY = "fictional-e2e-orchestrator-profile-key";
const SPECIALIST_KEY = "fictional-e2e-specialist-profile-key";
const PEER_TOKEN = "fictional-e2e-orchestrator-to-specialist-peer-token";

const HERMES_SCOPES: readonly ConnectorScope[] = [
  "hermes:agents:read", "hermes:conversations:read", "hermes:conversations:write", "hermes:delegations:read",
];
const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const credentials = [
  {
    serviceId: "pih-web", serviceToken: "fictional-e2e-pih-web-service-token-000000", delegatedIssuer: "https://pih-web.e2e.test.invalid",
    delegatedKey: key(71), actorTypes: ["human"], maxScopes: [...HERMES_SCOPES, "system:read"],
  },
  {
    serviceId: "hermes-central", serviceToken: "fictional-e2e-hermes-central-service-token", delegatedIssuer: "https://hermes-central.e2e.test.invalid",
    delegatedKey: key(72), actorTypes: ["agent"], maxScopes: ["calendar:read"], boundActorId: E2E_ACTOR_ID,
  },
  {
    serviceId: "telegram-gateway", serviceToken: "fictional-e2e-telegram-gateway-service-tok", delegatedIssuer: "https://telegram-gateway.e2e.test.invalid",
    delegatedKey: key(73), actorTypes: ["service"], maxScopes: ["hermes:agents:read"],
  },
  {
    serviceId: "pih-deployer", serviceToken: "fictional-e2e-pih-deployer-service-token-0", delegatedIssuer: "https://pih-deployer.e2e.test.invalid",
    delegatedKey: key(74), actorTypes: ["service"], maxScopes: ["health:read"],
  },
] as const;
const web = credentials[0];

/** Every fictional secret this runtime configures, profile keys first (orchestrator, specialist), for leak scans. */
export const fictionalSecrets = (): readonly string[] => [
  ORCHESTRATOR_KEY, SPECIALIST_KEY, PEER_TOKEN,
  ...credentials.map(({ serviceToken }) => serviceToken),
  ...credentials.map(({ delegatedKey }) => delegatedKey),
];

/** Starts a fake Hermes serving the two fictional profiles with their own keys. */
export const startDefaultFakeHermes = (): Promise<FakeHermesServer> => FakeHermesServer.start([
  { id: ORCHESTRATOR_ID, apiKey: ORCHESTRATOR_KEY },
  { id: SPECIALIST_ID, apiKey: SPECIALIST_KEY },
]);

export type TestClock = Readonly<{ now(): Date; advance(ms: number): void }>;
/** Wall clock plus a test-controlled offset, shared across restarts. */
export const testClock = (): TestClock => {
  let offset = 0;
  return { now: () => new Date(Date.now() + offset), advance: (ms) => { offset += ms; } };
};

const hermesEnvironment = (fake: FakeHermesServer, directory: string): Record<string, string> => {
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  return {
    HOST: "127.0.0.1",
    PORT: "0",
    CONNECTORS_DATABASE_PATH: join(directory, "connectors.sqlite"),
    CONNECTORS_SERVICE_CREDENTIALS_JSON: JSON.stringify(credentials),
    DEFAULT_TIME_ZONE: "Etc/UTC",
    LOG_LEVEL: "info",
    HERMES_API_ORIGIN: fake.origin,
    HERMES_DEFAULT_PROFILE_ID: ORCHESTRATOR_ID,
    HERMES_PROFILES_JSON: JSON.stringify([
      {
        id: ORCHESTRATOR_ID, displayName: "Orchestrator", keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY", enabled: true,
        capabilities: { directConversations: true, images: true, delegationTarget: false },
      },
      {
        id: SPECIALIST_ID, displayName: "Specialist A", keyEnvironment: "HERMES_SPECIALIST_A_API_KEY", enabled: true,
        capabilities: { directConversations: true, images: true, delegationTarget: true },
      },
    ]),
    HERMES_ORCHESTRATOR_API_KEY: ORCHESTRATOR_KEY,
    HERMES_SPECIALIST_A_API_KEY: SPECIALIST_KEY,
    HERMES_UPLOAD_DIRECTORY: join(directory, "uploads"),
    HERMES_IMAGE_MAX_BYTES: "4096",
    HERMES_UPLOAD_TTL_SECONDS: "600",
    HERMES_EVENT_RETENTION_HOURS: "24",
    HERMES_IDEMPOTENCY_RETENTION_HOURS: "24",
    HERMES_DELEGATION_ORCHESTRATOR_ID: ORCHESTRATOR_ID,
    HERMES_DELEGATION_SOCKET_PATH: join(directory, "delegation.sock"),
    // The service's own group: the only group an unprivileged test process may assign.
    HERMES_DELEGATION_SOCKET_GROUP_ID: String(gid > 0 ? gid : 65_534),
    HERMES_DELEGATION_PEERS_JSON: JSON.stringify([{
      sourceAgentId: ORCHESTRATOR_ID, ownerActorId: E2E_ACTOR_ID, targetAgentId: SPECIALIST_ID,
      tokenEnvironment: "HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN",
    }]),
    HERMES_ORCHESTRATOR_TO_SPECIALIST_A_PEER_TOKEN: PEER_TOKEN,
  };
};

const recordingHandle = (handle: SqliteHandle, sink: string[]): SqliteHandle => ({
  prepare: (sql) => { sink.push(sql); return handle.prepare(sql); },
  exec: (sql) => { sink.push(sql); handle.exec(sql); },
});

/** Records every SQL statement modules issue through the Foundation database port. */
const recordingDatabase = (database: ConnectorDatabase, sink: string[]): ConnectorDatabase => ({
  read: (operation) => database.read((handle) => operation(recordingHandle(handle, sink))),
  write: (operation) => database.write((handle) => operation(recordingHandle(handle, sink))),
  transaction: (operation) => database.transaction((handle) => operation(recordingHandle(handle, sink))),
  backupTo: (path) => database.backupTo(path),
  close: () => database.close(),
});

export type HermesTestRuntime = Readonly<{
  app: FastifyInstance;
  database: ConnectorDatabase;
  fakeHermes: FakeHermesServer;
  module: ConnectorModule;
  /** Loopback HTTP origin of the connectors app (test-only TCP transport). */
  baseUrl: string;
  delegationSocketPath: string;
  /** Captured connectors log lines. */
  logs: readonly string[];
  /** SQL issued through the database port (only when `recordSql`). */
  sql: string[];
  /** Registers an event stream so `close()` aborts it first. */
  track(controller: AbortController): void;
  close(): Promise<void>;
}>;

export async function createHermesTestRuntime(
  options: Readonly<{
    databasePath: string;
    fakeHermes?: FakeHermesServer;
    clock?: Readonly<{ now(): Date }>;
    idGenerator?: Readonly<{ generate(): string }>;
    environment?: Readonly<Record<string, string | undefined>>;
    recordSql?: boolean;
  }>,
): Promise<HermesTestRuntime> {
  const ownsFake = options.fakeHermes === undefined;
  const fakeHermes = options.fakeHermes ?? await startDefaultFakeHermes();
  const directory = dirname(options.databasePath);
  const environment: Readonly<Record<string, string | undefined>> = {
    ...hermesEnvironment(fakeHermes, directory), CONNECTORS_DATABASE_PATH: options.databasePath, ...options.environment,
  };
  const logs: string[] = [];
  const sql: string[] = [];
  const clock = options.clock ?? testClock();
  const idGenerator = options.idGenerator ?? { generate: randomUUID };
  let hermesModule: ConnectorModule | undefined;
  let running;
  try {
    running = await startConnectors({
      environment,
      process: {
        env: environment,
        getuid: () => process.getuid?.() ?? 0,
        on: () => undefined,
        off: () => undefined,
        stderr: { write: (value: string) => { logs.push(value); } },
      },
      openDatabase: (path) => {
        const database = openConnectorDatabase(path);
        return options.recordSql === true ? recordingDatabase(database, sql) : database;
      },
      createApp: (dependencies) => {
        hermesModule = dependencies.modules.find(({ name }) => name === "hermes");
        return createConnectorsApp({
          ...dependencies,
          clock,
          idGenerator,
          logger: { level: "info", stream: { write: (line: string) => { logs.push(line); } } } as never,
        });
      },
    });
  } catch (error) {
    if (ownsFake) await fakeHermes.stop();
    throw error;
  }
  if (hermesModule === undefined) throw new Error("hermes module was not composed");
  const address = running.app.server.address() as AddressInfo;
  const streams = new Set<AbortController>();
  let closing: Promise<void> | undefined;
  return Object.freeze({
    app: running.app,
    database: running.database,
    fakeHermes,
    module: hermesModule,
    baseUrl: `http://127.0.0.1:${address.port}`,
    delegationSocketPath: environment.HERMES_DELEGATION_SOCKET_PATH ?? "",
    logs,
    sql,
    track: (controller: AbortController) => { streams.add(controller); },
    close: () => {
      closing ??= (async () => {
        for (const controller of streams) controller.abort();
        await running.shutdown();
        if (ownsFake) await fakeHermes.stop();
      })();
      return closing;
    },
  });
}

export const webHeaders = async (
  actorId: string = E2E_ACTOR_ID,
  scopes: readonly ConnectorScope[] = HERMES_SCOPES,
): Promise<Record<string, string>> => ({
  "x-pih-service-token": web.serviceToken,
  authorization: "Bearer " + await new SignJWT({
    actor_id: actorId, actor_type: "human", scope: [...scopes], request_id: "request-fictional-e2e",
  }).setProtectedHeader({ alg: "HS256" }).setIssuer(web.delegatedIssuer).setAudience(CONNECTORS_AUDIENCE)
    .setSubject("fictional-e2e-subject").setIssuedAt().setExpirationTime("30s").sign(Buffer.from(web.delegatedKey, "base64url")),
});

export type Exchange = Readonly<{ label: string; status: number; headers: Record<string, unknown>; body: string }>;
type Method = "GET" | "POST" | "PUT" | "PATCH";

const multipart = (conversationId: string, bytes: Uint8Array, name: string, mimeType: string) => {
  const boundary = "fictional-e2e-boundary";
  const head = (field: string, filename?: string, type?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"${filename === undefined ? "" : `; filename="${filename}"`}\r\n` +
    (type === undefined ? "" : `Content-Type: ${type}\r\n`) + "\r\n";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(head("conversationId") + conversationId + "\r\n" + head("kind") + "attachment\r\n" + head("media", name, mimeType)),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
};

/** BFF client acting as the web service for one human actor; records every exchange for leak scans. */
export const hermesClient = (runtime: HermesTestRuntime, actorId: string = E2E_ACTOR_ID) => {
  const exchanges: Exchange[] = [];
  const call = async (method: Method, url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await runtime.app.inject({
      method, url, headers: { ...await webHeaders(actorId), ...extra },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    exchanges.push({ label: `${method} ${url}`, status: response.statusCode, headers: response.headers, body: response.body });
    return response;
  };
  return {
    exchanges,
    headers: (scopes: readonly ConnectorScope[] = HERMES_SCOPES) => webHeaders(actorId, scopes),
    async json(method: Method, url: string, status: number, body?: unknown, extra?: Record<string, string>): Promise<unknown> {
      const response = await call(method, url, body, extra);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
      return JSON.parse(response.body) as unknown;
    },
    async problem(method: Method, url: string, status: number, code: string, body?: unknown, extra?: Record<string, string>) {
      const response = await call(method, url, body, extra);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
      expect(String(response.headers["content-type"])).toContain("application/problem+json");
      const problem = ApiProblemSchema.parse(JSON.parse(response.body));
      expect(problem.code).toBe(code);
      return problem;
    },
    async upload(conversationId: string, bytes: Uint8Array, name: string, mimeType: string, status: number): Promise<unknown> {
      const form = multipart(conversationId, bytes, name, mimeType);
      const response = await runtime.app.inject({
        method: "POST", url: "/v1/uploads", headers: { ...await webHeaders(actorId), "content-type": form.contentType }, payload: form.payload,
      });
      exchanges.push({ label: "POST /v1/uploads", status: response.statusCode, headers: response.headers, body: response.body });
      expect(response.statusCode, response.body).toBe(status);
      return JSON.parse(response.body) as unknown;
    },
  };
};

export type StreamedEvent = Readonly<{ id: string; type: string; delta?: string; message?: unknown; code?: string }>;

/**
 * Reads normalized SSE events from the live connectors HTTP listener until
 * `until` matches, no event arrives for `idleMs`, or `timeoutMs` passes.
 */
export const readEvents = async (
  runtime: HermesTestRuntime,
  conversationId: string,
  options: Readonly<{ lastEventId?: string; until?: (event: StreamedEvent) => boolean; idleMs?: number; timeoutMs?: number; actorId?: string }> = {},
): Promise<StreamedEvent[]> => {
  const controller = new AbortController();
  runtime.track(controller);
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const events: StreamedEvent[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (options.idleMs === undefined) return;
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), options.idleMs);
  };
  try {
    const response = await fetch(`${runtime.baseUrl}/v1/conversations/${conversationId}/events`, {
      headers: { ...await webHeaders(options.actorId), ...(options.lastEventId === undefined ? {} : { "last-event-id": options.lastEventId }) },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data.length === 0) continue;
        const event = JSON.parse(data) as StreamedEvent;
        const id = /^id: (.*)$/mu.exec(frame)?.[1];
        expect(id).toBe(event.id);
        events.push(event);
        armIdle();
        if (options.until?.(event) === true) {
          controller.abort();
          return events;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(idle);
    controller.abort();
  }
  if (options.until !== undefined) throw new Error("event stream ended before the expected event");
  return events;
};

/** Calls the agent-only delegation endpoint over its Unix socket as the orchestrator's peer. */
export const postDelegation = (
  runtime: HermesTestRuntime,
  input: Readonly<{ idempotencyKey: string; body: unknown; token?: string }>,
): Promise<Readonly<{ status: number; body: string }>> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(input.body);
  const request = httpRequest({
    socketPath: runtime.delegationSocketPath, path: DELEGATION_PATH, method: "POST",
    headers: {
      authorization: `Bearer ${input.token ?? PEER_TOKEN}`, "content-type": "application/json",
      "idempotency-key": input.idempotencyKey, "content-length": Buffer.byteLength(payload),
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    response.on("error", reject);
  });
  request.on("error", reject);
  request.end(payload);
});
