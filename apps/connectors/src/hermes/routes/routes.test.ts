import { readdir } from "node:fs/promises";

import {
  AgentSummarySchema,
  ApiProblemSchema,
  ConversationListSchema,
  ConversationSchema,
  ConversationSelectionSchema,
  DelegationListSchema,
  DelegationSchema,
  HermesCapabilitiesSchema,
  MessageHistorySchema,
  MessageSchema,
  UploadedMediaSchema,
  type ConnectorScope,
  type ConnectorServiceId,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actorId,
  createHermesHarness,
  disposeHermesHarnesses,
  foreignActorId,
  imageFixtures,
  orchestratorId,
  specialistAId,
  specialistBId,
  type HermesHarness,
} from "../../../test/hermes/harness.js";
import { createConnectorsApp } from "../../app.js";
import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../../config/private.js";
import { createHermesModule } from "../module.js";
import { createHermesRuntime } from "../runtime.js";
import { EventRepository } from "../storage/event-repository.js";

/** Fictional identities, keys, and tokens only. */
const HERMES_SCOPES: readonly ConnectorScope[] = [
  "hermes:agents:read", "hermes:conversations:read", "hermes:conversations:write", "hermes:delegations:read",
];
const credential = (
  serviceId: ConnectorServiceId, fill: number, actorTypes: ServiceCredentialPolicy["actorTypes"], boundActorId?: string,
): ServiceCredentialPolicy => ({
  serviceId, serviceToken: `test-only-${serviceId}-credential-`.padEnd(40, "0"),
  delegatedIssuer: `https://${serviceId}.test.invalid`, delegatedKey: new Uint8Array(32).fill(fill),
  actorTypes, maxScopes: [...HERMES_SCOPES], ...(boundActorId === undefined ? {} : { boundActorId }),
});
const web = credential("pih-web", 41, ["human"]);
const central = credential("hermes-central", 42, ["agent"], actorId);
const telegram = credential("telegram-gateway", 43, ["service"]);
const deployer = credential("pih-deployer", 44, ["service"]);
const connectorsConfig: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/hermes-routes-test.sqlite",
  serviceCredentials: [web, central, telegram, deployer], audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "Etc/UTC", logLevel: "error",
};

type Caller = Readonly<{ credential: ServiceCredentialPolicy; actorType: "human" | "agent" | "service"; actorId?: string; claims?: Record<string, unknown> }>;
const human = (id = actorId): Caller => ({ credential: web, actorType: "human", actorId: id });

const headersFor = async (caller: Caller, scopes: readonly ConnectorScope[], serviceToken = caller.credential.serviceToken) => ({
  "x-pih-service-token": serviceToken,
  authorization: "Bearer " + await new SignJWT({
    actor_id: caller.actorId ?? actorId, actor_type: caller.actorType, scope: [...scopes], request_id: "request-fictional",
    ...caller.claims,
  }).setProtectedHeader({ alg: "HS256" }).setIssuer(caller.credential.delegatedIssuer)
    .setAudience(CONNECTORS_AUDIENCE).setSubject("fictional-subject").setIssuedAt().setExpirationTime("30s")
    .sign(caller.credential.delegatedKey),
});

const SECRET_PATTERN = /fictional-[a-z-]*-key|127\.0\.0\.1|8642|pih_conversation|run_fictional|\/p\/|SQLITE|stack/iu;

const capabilityBody = (overrides: Record<string, unknown> = {}) => ({
  text: true, streaming: true, voice: { enabled: false },
  attachments: { enabled: true, acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"], maxFiles: 3, maxBytes: 1024 },
  agentConversations: true, ...overrides,
});

type UpstreamHandler = (profile: string, method: string, path: string, body: unknown) => Response | Promise<Response> | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const fakeUpstream = (handler: UpstreamHandler = () => undefined) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const match = /^\/p\/([^/]+)\/(.*)$/u.exec(url.pathname);
  if (match === null) return json({ error: "unexpected" }, 500);
  const [, profile, path] = match as unknown as [string, string, string];
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  const custom = await handler(profile, method, path, body);
  if (custom !== undefined) return custom;
  if (method === "GET" && path === "v1/capabilities") return json(capabilityBody());
  if (method === "POST" && path === "api/sessions") {
    const session = body as { session_id: string; title: string; source: string };
    return json({ object: "hermes.session", session: { id: session.session_id, source: session.source, title: session.title } });
  }
  if (method === "PATCH" && path.startsWith("api/sessions/")) {
    return json({ object: "hermes.session", session: { id: decodeURIComponent(path.slice("api/sessions/".length)), source: "pih" } });
  }
  if (method === "POST" && path === "v1/runs") return json({ run_id: "run_fictional_01", status: "queued", replayed: false });
  return json({ error: "unexpected" }, 500);
});

const idleWorker = () => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) });

type World = Readonly<{ app: FastifyInstance; harness: HermesHarness; upstream: ReturnType<typeof fakeUpstream> }>;
const apps: FastifyInstance[] = [];

const world = async (handler?: UpstreamHandler): Promise<World> => {
  const harness = await createHermesHarness();
  const upstream = fakeUpstream(handler);
  const options = { config: harness.config, fetch: upstream as unknown as typeof fetch };
  const module = createHermesModule(options, (dependencies) => createHermesRuntime(options, dependencies, {
    delegationServer: undefined, reconciler: idleWorker(), delegationReconciler: idleWorker(), maintenance: idleWorker(),
  }));
  const app = await createConnectorsApp({
    config: connectorsConfig, database: harness.database, clock: harness.clock, idGenerator: harness.ids, modules: [module],
  });
  apps.push(app);
  return { app, harness, upstream };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await disposeHermesHarnesses();
});

const expectProblem = (response: { statusCode: number; body: string; headers: Record<string, unknown> }, status: number, code: string) => {
  expect(response.statusCode, response.body).toBe(status);
  expect(String(response.headers["content-type"])).toContain("application/problem+json");
  const problem = ApiProblemSchema.parse(JSON.parse(response.body));
  expect(problem.code).toBe(code);
  expect(response.body).not.toMatch(SECRET_PATTERN);
  return problem;
};

type RouteCase = Readonly<{
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  url: (ids: Readonly<{ conversation: string }>) => string;
  scope: ConnectorScope;
  body?: unknown;
  headers?: Record<string, string>;
  successStatus: number;
}>;

const ROUTES: readonly RouteCase[] = [
  { name: "capabilities", method: "GET", url: () => "/v1/capabilities", scope: "hermes:agents:read", successStatus: 200 },
  { name: "agents", method: "GET", url: () => "/v1/agents", scope: "hermes:agents:read", successStatus: 200 },
  { name: "list conversations", method: "GET", url: () => "/v1/conversations", scope: "hermes:conversations:read", successStatus: 200 },
  { name: "create conversation", method: "POST", url: () => "/v1/conversations", scope: "hermes:conversations:write", body: { agentId: specialistAId }, successStatus: 201 },
  { name: "main conversation", method: "PUT", url: () => `/v1/agents/${specialistAId}/main-conversation`, scope: "hermes:conversations:write", successStatus: 200 },
  { name: "get conversation", method: "GET", url: ({ conversation }) => `/v1/conversations/${conversation}`, scope: "hermes:conversations:read", successStatus: 200 },
  { name: "patch conversation", method: "PATCH", url: ({ conversation }) => `/v1/conversations/${conversation}`, scope: "hermes:conversations:write", body: { title: "Renamed thread", expectedVersion: 1 }, successStatus: 200 },
  { name: "message history", method: "GET", url: ({ conversation }) => `/v1/conversations/${conversation}/messages`, scope: "hermes:conversations:read", successStatus: 200 },
  {
    name: "send message", method: "POST", url: ({ conversation }) => `/v1/conversations/${conversation}/messages`, scope: "hermes:conversations:write",
    body: { parts: [{ kind: "text", text: "Fictional question" }] }, headers: { "idempotency-key": "client-key-0001" }, successStatus: 202,
  },
  { name: "selection read", method: "GET", url: () => `/v1/agents/${specialistAId}/conversation-selection`, scope: "hermes:conversations:read", successStatus: 200 },
  {
    name: "selection write", method: "PUT", url: () => `/v1/agents/${specialistAId}/conversation-selection`, scope: "hermes:conversations:write",
    body: { conversationId: "conversation-01", expectedVersion: 0 }, successStatus: 200,
  },
  { name: "delegations", method: "GET", url: () => "/v1/delegations", scope: "hermes:delegations:read", successStatus: 200 },
];

const inject = async (app: FastifyInstance, route: RouteCase, headers: Record<string, string>) => app.inject({
  method: route.method,
  url: route.url({ conversation: "conversation-01" }),
  headers: { ...headers, ...route.headers },
  ...(route.body === undefined ? {} : { payload: route.body as object }),
});

describe("Hermes BFF routes: authorization", () => {
  it.each(ROUTES)("$name succeeds for pih-web with exactly its scope", async (route) => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const response = await inject(app, route, await headersFor(human(), [route.scope]));
    expect(response.statusCode, response.body).toBe(route.successStatus);
  });

  it.each(ROUTES)("$name refuses pih-web without its scope", async (route) => {
    const { app, harness, upstream } = await world();
    await harness.seedConversation();
    const response = await inject(app, route, await headersFor(human(), HERMES_SCOPES.filter((scope) => scope !== route.scope)));
    expectProblem(response, 403, "forbidden");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("$name refuses verified non-web services holding the scope", async (route) => {
    const { app, harness, upstream } = await world();
    await harness.seedConversation();
    for (const caller of [
      { credential: central, actorType: "agent", actorId } as const,
      { credential: telegram, actorType: "service" } as const,
      { credential: deployer, actorType: "service" } as const,
    ]) {
      const response = await inject(app, route, await headersFor(caller, [route.scope]));
      expectProblem(response, 403, "forbidden");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never trusts a self-asserted service_id claim", async () => {
    const { app } = await world();
    const selfAsserted = await headersFor({ credential: telegram, actorType: "service", claims: { service_id: "pih-web" } }, ["hermes:agents:read"]);
    expectProblem(await app.inject({ method: "GET", url: "/v1/agents", headers: selfAsserted }), 403, "forbidden");
    const mixed = await headersFor({ credential: telegram, actorType: "service", claims: { service_id: "pih-web" } }, ["hermes:agents:read"], web.serviceToken);
    expectProblem(await app.inject({ method: "GET", url: "/v1/agents", headers: mixed }), 401, "authentication_required");
  });

  it("requires authentication on every Hermes route", async () => {
    const { app } = await world();
    for (const route of ROUTES) {
      expectProblem(await inject(app, route, {}), 401, "authentication_required");
    }
  });

  it("does not serve the agent-only delegation operation on the BFF app", async () => {
    const { app } = await world();
    const response = await app.inject({
      method: "POST", url: "/internal/v1/hermes/delegations",
      headers: { ...await headersFor(human(), HERMES_SCOPES), "idempotency-key": "delegation-key-1" },
      payload: { targetAgentId: specialistAId, message: "Fictional task" },
    });
    expect(response.statusCode).toBe(404);
    const peer = await app.inject({
      method: "POST", url: "/internal/v1/hermes/delegations",
      headers: { authorization: "Bearer fictional-specialist-a-peer-token-32-bytes" },
      payload: { targetAgentId: specialistAId, message: "Fictional task" },
    });
    expectProblem(peer, 401, "authentication_required");
  });
});

describe("Hermes BFF routes: capabilities and agents", () => {
  it("disables attachments when one direct profile's policy lacks image support", async () => {
    const { app } = await world();
    const response = await app.inject({ method: "GET", url: "/v1/capabilities", headers: await headersFor(human(), ["hermes:agents:read"]) });
    expect(response.statusCode).toBe(200);
    expect(HermesCapabilitiesSchema.parse(response.json())).toEqual({
      text: true, streaming: true, voice: { enabled: false },
      attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 3, maxBytes: 1024 },
      agentConversations: true,
    });
  });

  it("enables attachments when every enabled direct profile supports images upstream and in policy", async () => {
    const harness = await createHermesHarness({
      HERMES_PROFILES_JSON: JSON.stringify([
        { id: orchestratorId, displayName: "Orchestrator", keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY", enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: false } },
        { id: specialistAId, displayName: "Specialist A", keyEnvironment: "HERMES_SPECIALIST_A_API_KEY", enabled: true, capabilities: { directConversations: true, images: true, delegationTarget: true } },
      ]),
    });
    const upstream = fakeUpstream();
    const options = { config: harness.config, fetch: upstream as unknown as typeof fetch };
    const imagesApp = await createConnectorsApp({
      config: connectorsConfig, database: harness.database, clock: harness.clock, idGenerator: harness.ids,
      modules: [createHermesModule(options, (dependencies) => createHermesRuntime(options, dependencies, {
        delegationServer: undefined, reconciler: idleWorker(), delegationReconciler: idleWorker(), maintenance: idleWorker(),
      }))],
    });
    apps.push(imagesApp);
    const response = await imagesApp.inject({ method: "GET", url: "/v1/capabilities", headers: await headersFor(human(), ["hermes:agents:read"]) });
    expect(response.json()).toEqual({
      text: true, streaming: true, voice: { enabled: false },
      attachments: { enabled: true, acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"], maxFiles: 3, maxBytes: 1024 },
      agentConversations: true,
    });
  });

  it("disables attachments when one profile lacks authenticated evidence", async () => {
    const { app } = await world((profile, _method, path) =>
      profile === specialistAId && path === "v1/capabilities" ? json({ error: "denied" }, 401) : undefined);
    const response = await app.inject({ method: "GET", url: "/v1/capabilities", headers: await headersFor(human(), ["hermes:agents:read"]) });
    expect(response.json().attachments.enabled).toBe(false);
  });

  it("lists configured agents without fabricating availability", async () => {
    const { app } = await world((profile, _method, path) => {
      if (path !== "v1/capabilities") return undefined;
      if (profile === specialistAId) throw new TypeError("connect ECONNREFUSED 127.0.0.1:8642");
      if (profile === specialistBId) return json({ unexpected: true });
      return undefined;
    });
    const response = await app.inject({ method: "GET", url: "/v1/agents", headers: await headersFor(human(), ["hermes:agents:read"]) });
    expect(response.statusCode).toBe(200);
    const agents = (response.json() as unknown[]).map((item) => AgentSummarySchema.parse(item));
    expect(agents.map(({ id, availability }) => [id, availability])).toEqual([
      [orchestratorId, "online"], [specialistAId, "offline"], [specialistBId, "unknown"],
    ]);
    expect(agents.every(({ execution, result, attention }) => execution === "unknown" && result === "unknown" && attention === "unknown")).toBe(true);
    expect(response.body).not.toMatch(SECRET_PATTERN);
  });
});

describe("Hermes BFF routes: conversations and ownership", () => {
  it("creates, reads, renames, and lists only the caller's conversations", async () => {
    const { app, harness } = await world();
    await harness.seedConversation({ id: "foreign-01", actorId: foreignActorId, agentId: specialistBId });
    const write = await headersFor(human(), ["hermes:conversations:write", "hermes:conversations:read"]);
    const created = await app.inject({ method: "POST", url: "/v1/conversations", headers: write, payload: { agentId: specialistBId, title: "Budget" } });
    expect(created.statusCode).toBe(201);
    const conversation = ConversationSchema.parse(created.json());
    expect(conversation).toMatchObject({ agentId: specialistBId, kind: "direct", title: "Budget", isMain: false });
    const listed = ConversationListSchema.parse((await app.inject({ method: "GET", url: "/v1/conversations?limit=10", headers: write })).json());
    expect(listed.items.map(({ id }) => id)).toEqual([conversation.id]);
    const patched = await app.inject({
      method: "PATCH", url: `/v1/conversations/${conversation.id}`, headers: write, payload: { title: "Budget 2", expectedVersion: conversation.version },
    });
    expect(ConversationSchema.parse(patched.json()).title).toBe("Budget 2");
    const stale = await app.inject({
      method: "PATCH", url: `/v1/conversations/${conversation.id}`, headers: write, payload: { title: "Budget 3", expectedVersion: conversation.version },
    });
    expectProblem(stale, 409, "version_conflict");
  });

  it("returns not_found for another actor's thread on every conversation route", async () => {
    const { app, harness, upstream } = await world();
    await harness.seedConversation({ id: "foreign-01", actorId: foreignActorId, agentId: specialistBId });
    const headers = await headersFor(human(), HERMES_SCOPES);
    const attempts = [
      { method: "GET", url: "/v1/conversations/foreign-01" },
      { method: "PATCH", url: "/v1/conversations/foreign-01", payload: { title: "Taken", expectedVersion: 2 } },
      { method: "GET", url: "/v1/conversations/foreign-01/messages" },
      { method: "GET", url: "/v1/conversations/foreign-01/events" },
      { method: "POST", url: "/v1/conversations/foreign-01/messages", payload: { parts: [{ kind: "text", text: "Hi" }] }, headers: { "idempotency-key": "client-key-0002" } },
      { method: "PUT", url: `/v1/agents/${specialistBId}/conversation-selection`, payload: { conversationId: "foreign-01", expectedVersion: 0 } },
    ] as const;
    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method, url: attempt.url, headers: { ...headers, ...("headers" in attempt ? attempt.headers : {}) },
        ...("payload" in attempt ? { payload: attempt.payload } : {}),
      });
      expectProblem(response, 404, "not_found");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps a conversation bound to its profile: another agent's selection cannot adopt it", async () => {
    const { app, harness } = await world();
    await harness.seedConversation({ id: "budget-01", agentId: specialistBId });
    const headers = await headersFor(human(), HERMES_SCOPES);
    const crossProfile = await app.inject({
      method: "PUT", url: `/v1/agents/${specialistAId}/conversation-selection`, headers, payload: { conversationId: "budget-01", expectedVersion: 0 },
    });
    expectProblem(crossProfile, 404, "not_found");
    const unknownProfile = await app.inject({ method: "GET", url: "/v1/agents/not-configured/conversation-selection", headers });
    expectProblem(unknownProfile, 404, "not_found");
    const filtered = await app.inject({ method: "GET", url: `/v1/conversations?agentId=${specialistAId}`, headers });
    expect(ConversationListSchema.parse(filtered.json()).items).toEqual([]);
    const own = await app.inject({
      method: "PUT", url: `/v1/agents/${specialistBId}/conversation-selection`, headers, payload: { conversationId: "budget-01", expectedVersion: 0 },
    });
    expect(ConversationSelectionSchema.parse(own.json())).toMatchObject({ agentId: specialistBId, conversationId: "budget-01", version: 1 });
  });

  it("ensures one main conversation per agent idempotently", async () => {
    const { app } = await world();
    const headers = await headersFor(human(), HERMES_SCOPES);
    const first = await app.inject({ method: "PUT", url: `/v1/agents/${specialistAId}/main-conversation`, headers });
    const second = await app.inject({ method: "PUT", url: `/v1/agents/${specialistAId}/main-conversation`, headers });
    expect(ConversationSchema.parse(first.json()).isMain).toBe(true);
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects malformed pagination, unknown query fields, and malformed bodies with normalized problems", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const headers = await headersFor(human(), HERMES_SCOPES);
    for (const url of [
      "/v1/conversations?limit=0", "/v1/conversations?limit=abc", "/v1/conversations?unknown=1",
      "/v1/conversations/conversation-01/messages?limit=1000", "/v1/delegations?limit=-1", "/v1/delegations?state=bogus",
      "/v1/capabilities?x=1",
    ]) {
      expectProblem(await app.inject({ method: "GET", url, headers }), 400, "validation_failed");
    }
    expectProblem(await app.inject({ method: "GET", url: "/v1/conversations?cursor=not-a-cursor", headers }), 400, "invalid_cursor");
    expectProblem(await app.inject({ method: "POST", url: "/v1/conversations", headers, payload: { agentId: specialistAId, extra: 1 } }), 400, "validation_failed");
    expectProblem(await app.inject({
      method: "POST", url: "/v1/conversations", headers: { ...headers, "content-type": "application/json" }, payload: "{not json",
    }), 400, "validation_failed");
  });

  it("maps upstream failures and unknown upstream fields to sanitized dependency problems", async () => {
    let mode: "down" | "unknown-field" = "down";
    const { app } = await world((_profile, method, path) => {
      if (method !== "POST" || path !== "api/sessions") return undefined;
      if (mode === "down") throw new TypeError("connect ECONNREFUSED 127.0.0.1:8642 fictional-orchestrator-key");
      return json({ object: "hermes.session", session: { id: "pih_x", source: "pih" }, debug: "fictional-specialist-a-key" });
    });
    const headers = await headersFor(human(), HERMES_SCOPES);
    expectProblem(await app.inject({ method: "POST", url: "/v1/conversations", headers, payload: { agentId: specialistAId } }), 503, "dependency_unavailable");
    mode = "unknown-field";
    expectProblem(await app.inject({ method: "POST", url: "/v1/conversations", headers, payload: { agentId: specialistAId } }), 502, "dependency_unavailable");
  });
});

describe("Hermes BFF routes: messages and events", () => {
  it("admits a message once per idempotency key and returns the transactional stream cursor", async () => {
    const { app, harness, upstream } = await world();
    await harness.seedConversation();
    const headers = await headersFor(human(), HERMES_SCOPES);
    const send = (key: string | undefined, text = "Fictional question") => app.inject({
      method: "POST", url: "/v1/conversations/conversation-01/messages",
      headers: key === undefined ? headers : { ...headers, "idempotency-key": key },
      payload: { parts: [{ kind: "text", text }] },
    });
    expectProblem(await send(undefined), 400, "idempotency_key_required");
    const first = await send("client-key-0001");
    expect(first.statusCode).toBe(202);
    expect(MessageSchema.parse(first.json())).toMatchObject({ role: "user", deliveryState: "accepted" });
    const replay = await send("client-key-0001");
    expect(replay.json()).toEqual(first.json());
    expectProblem(await send("client-key-0001", "Different body"), 409, "idempotency_key_reused");
    expect(upstream.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    const history = await app.inject({ method: "GET", url: "/v1/conversations/conversation-01/messages?limit=10", headers });
    const parsed = MessageHistorySchema.parse(history.json());
    expect(parsed.items.map(({ role }) => role).sort()).toEqual(["assistant", "user"]);
    expect(parsed.streamCursor).toBe("1");
  });

  it("refuses duplicated idempotency headers", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const headers = await headersFor(human(), HERMES_SCOPES);
    const response = await app.inject({
      method: "POST", url: "/v1/conversations/conversation-01/messages",
      headers: { ...headers, "idempotency-key": ["client-key-0001", "client-key-0002"] },
      payload: { parts: [{ kind: "text", text: "Fictional question" }] },
    });
    expectProblem(response, 400, "validation_failed");
  });

  it("answers an expired or invalid event cursor before opening the stream", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    await harness.database.transaction((db) => {
      const events = new EventRepository();
      events.append(db, actorId, "conversation-01", { id: "0", type: "heartbeat", occurredAt: "2026-10-11T00:00:00.000Z" }, "2026-10-11T01:00:00.000Z");
      events.append(db, actorId, "conversation-01", { id: "0", type: "heartbeat", occurredAt: "2026-10-12T11:00:00.000Z" }, "2026-10-13T01:00:00.000Z");
      events.deleteExpired(db, "2026-10-12T00:00:00.000Z");
    });
    const headers = await headersFor(human(), ["hermes:conversations:read"]);
    expectProblem(await app.inject({ method: "GET", url: "/v1/conversations/conversation-01/events", headers: { ...headers, "last-event-id": "0" } }), 410, "event_cursor_expired");
    expectProblem(await app.inject({ method: "GET", url: "/v1/conversations/conversation-01/events", headers: { ...headers, "last-event-id": "abc" } }), 400, "invalid_cursor");
    expectProblem(await app.inject({ method: "GET", url: "/v1/conversations/conversation-01/events", headers: { ...headers, "last-event-id": "99" } }), 400, "invalid_cursor");
  });

  it("streams normalized events as server-sent events with anti-buffering headers", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    await harness.database.transaction((db) => new EventRepository().append(
      db, actorId, "conversation-01", { id: "0", type: "agent.changed", agentId: specialistAId, occurredAt: "2026-10-12T11:00:00.000Z" }, "2026-10-13T01:00:00.000Z",
    ));
    const headers = await headersFor(human(), ["hermes:conversations:read"]);
    const response = await app.inject({
      method: "GET", url: "/v1/conversations/conversation-01/events", headers: { ...headers, "last-event-id": "0" }, payloadAsStream: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
    const stream = response.stream();
    const chunk = await new Promise<string>((resolve) => stream.once("data", (data: Buffer) => resolve(data.toString("utf8"))));
    expect(chunk).toContain("id: 1\nevent: agent.changed\n");
    expect(chunk).not.toMatch(SECRET_PATTERN);
    stream.destroy();
  });
});

const BOUNDARY = "----fictional-boundary-7f3a";
const multipart = (parts: readonly Readonly<{ name: string; value: string | Uint8Array; filename?: string; type?: string }>[]) => {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"` +
      (part.filename === undefined ? "" : `; filename="${part.filename}"`) + "\r\n" +
      (part.type === undefined ? "" : `Content-Type: ${part.type}\r\n`) + "\r\n"));
    chunks.push(Buffer.from(part.value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
};
const conversationField = (id = "conversation-01") => ({ name: "conversationId", value: id });
const kindField = { name: "kind", value: "attachment" };
const mediaPart = (bytes: Uint8Array = imageFixtures.png(64)) => ({ name: "media", value: bytes, filename: "scale.png", type: "image/png" });

describe("Hermes BFF routes: uploads", () => {
  const upload = async (app: FastifyInstance, payload: Buffer, actor = actorId) => app.inject({
    method: "POST", url: "/v1/uploads",
    headers: { ...await headersFor(human(actor), ["hermes:conversations:write"]), "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
  const storedFiles = async (harness: HermesHarness) => readdir(harness.uploadDirectory).catch(() => []);

  it("stores one image sent as conversationId, kind, then media", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const response = await upload(app, multipart([conversationField(), kindField, mediaPart()]));
    expect(response.statusCode, response.body).toBe(201);
    expect(UploadedMediaSchema.parse(response.json())).toMatchObject({ kind: "attachment", name: "scale.png", mimeType: "image/png", size: 64 });
    expect(await storedFiles(harness)).toHaveLength(1);
  });

  it.each([
    ["file before ownership fields", [mediaPart(), conversationField(), kindField]],
    ["repeated field", [conversationField(), conversationField(), kindField, mediaPart()]],
    ["unknown field", [conversationField(), kindField, { name: "note", value: "x" }, mediaPart()]],
    ["second file", [conversationField(), kindField, mediaPart(), mediaPart()]],
    ["wrong kind", [conversationField(), { name: "kind", value: "voice" }, mediaPart()]],
    ["media without filename", [conversationField(), kindField, { name: "media", value: imageFixtures.png(64), type: "image/png" }]],
    ["mismatched magic bytes", [conversationField(), kindField, { ...mediaPart(imageFixtures.jpeg(64)) }]],
  ] as const)("rejects %s without persisting bytes", async (_name, parts) => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const response = await upload(app, multipart(parts));
    expectProblem(response, 400, "validation_failed");
    expect(await storedFiles(harness)).toEqual([]);
  });

  it("checks ownership before buffering media: a foreign conversation is not_found even for oversized media", async () => {
    const { app, harness } = await world();
    await harness.seedConversation({ id: "foreign-01", actorId: foreignActorId });
    const response = await upload(app, multipart([conversationField("foreign-01"), kindField, mediaPart(imageFixtures.png(4096))]));
    expectProblem(response, 404, "not_found");
    expect(await storedFiles(harness)).toEqual([]);
  });

  it("enforces the configured image size limit while streaming", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const response = await upload(app, multipart([conversationField(), kindField, mediaPart(imageFixtures.png(4096))]));
    expectProblem(response, 413, "payload_too_large");
    expect(await storedFiles(harness)).toEqual([]);
  });

  it("rejects non-multipart and malformed multipart bodies", async () => {
    const { app, harness } = await world();
    await harness.seedConversation();
    const headers = await headersFor(human(), ["hermes:conversations:write"]);
    expectProblem(await app.inject({ method: "POST", url: "/v1/uploads", headers, payload: { conversationId: "conversation-01" } }), 400, "validation_failed");
    expectProblem(await upload(app, Buffer.from("garbage without boundary")), 400, "validation_failed");
    expect(await storedFiles(harness)).toEqual([]);
  });
});

describe("Hermes BFF routes: delegations", () => {
  const seedDelegation = async (harness: HermesHarness, id: string, owner: string, createdAt: string) =>
    harness.database.transaction((db) => db.prepare(
      "INSERT INTO hermes_delegations(id, actor_id, source_agent_id, target_agent_id, source_conversation_id, upstream_session_id, upstream_run_id, " +
      "idempotency_key, request_hash, state, safe_summary, result_summary, created_at, updated_at, completed_at) VALUES(:id, :owner, :source, :target, NULL, " +
      "'pih_bot_fictional', 'run_fictional_77', :key, 'hash', 'completed', NULL, 'Fictional result', :createdAt, :createdAt, :createdAt)",
    ).run({ id, owner, source: orchestratorId, target: specialistBId, key: `key-${id}`, createdAt }));

  it("lists and reads only the caller's delegations without upstream identifiers", async () => {
    const { app, harness } = await world();
    await seedDelegation(harness, "delegation-01", actorId, "2026-10-12T10:00:00.000Z");
    await seedDelegation(harness, "delegation-02", actorId, "2026-10-12T11:00:00.000Z");
    await seedDelegation(harness, "delegation-foreign", foreignActorId, "2026-10-12T11:30:00.000Z");
    const headers = await headersFor(human(), ["hermes:delegations:read"]);
    const page = await app.inject({ method: "GET", url: "/v1/delegations?limit=1", headers });
    const first = DelegationListSchema.parse(page.json());
    expect(first.items.map(({ id }) => id)).toEqual(["delegation-02"]);
    expect(page.body).not.toMatch(SECRET_PATTERN);
    const next = await app.inject({ method: "GET", url: `/v1/delegations?limit=1&cursor=${first.pageInfo.nextCursor}`, headers });
    expect(DelegationListSchema.parse(next.json()).items.map(({ id }) => id)).toEqual(["delegation-01"]);
    const one = await app.inject({ method: "GET", url: "/v1/delegations/delegation-01", headers });
    expect(DelegationSchema.parse(one.json())).toMatchObject({ id: "delegation-01", targetAgentId: specialistBId, resultSummary: "Fictional result" });
    expectProblem(await app.inject({ method: "GET", url: "/v1/delegations/delegation-foreign", headers }), 404, "not_found");
    expectProblem(await app.inject({ method: "GET", url: "/v1/delegations?cursor=bad", headers }), 400, "invalid_cursor");
  });
});
