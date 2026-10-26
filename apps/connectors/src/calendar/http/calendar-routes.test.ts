import {
  ApiProblemSchema,
  CalendarAgendaSchema,
  CalendarChangeProposalSchema,
  CalendarSourceStatusSchema,
  SourceStatusSchema,
  type CalendarAgenda,
  type CalendarAuthorizationStart,
  type CalendarChangeProposal,
  type CalendarEventDetail,
  type CalendarEventList,
  type CalendarSelection,
  type CalendarSourceStatus,
  type ConnectorScope,
  type ConnectorServiceId,
  type DelegatedPrincipal,
  type SourceStatus,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { createConnectorsApp } from "../../app.js";
import { CONNECTORS_AUDIENCE, type ConnectorsConfig, type ServiceCredentialPolicy } from "../../config/private.js";
import { openTestDatabase, closeTestDatabases } from "../../../test/calendar/fixtures.js";
import { createCalendarModule, type CalendarModuleDependencies } from "../calendar-module.js";

/** Fictional identities and keys only. */
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const STRANGER = "00000000-0000-4000-8000-0000000000a2";
const REQUEST_ID = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const NOW = "2026-10-12T12:00:00.000Z";

const credential = (
  serviceId: ConnectorServiceId, fill: number, actorTypes: ServiceCredentialPolicy["actorTypes"],
  maxScopes: readonly ConnectorScope[], boundActorId?: string,
): ServiceCredentialPolicy => ({
  serviceId, serviceToken: `test-only-${serviceId}-credential-`.padEnd(40, "0"),
  delegatedIssuer: `https://${serviceId}.test.invalid`, delegatedKey: new Uint8Array(32).fill(fill),
  actorTypes, maxScopes, ...(boundActorId === undefined ? {} : { boundActorId }),
});
const web = credential("pih-web", 31, ["human"], ["calendar:read", "calendar:propose", "calendar:confirm", "calendar:configure", "system:read"]);
const central = credential("hermes-central", 32, ["agent"], ["calendar:read", "calendar:propose"], OWNER);
const telegram = credential("telegram-gateway", 33, ["service"], ["hermes:conversations:read"]);
const deployer = credential("pih-deployer", 34, ["service"], ["health:read"]);
const config: ConnectorsConfig = {
  transport: { kind: "tcp-test-only", host: "127.0.0.1", port: 0 },
  databasePath: "/tmp/calendar-routes-test.sqlite",
  serviceCredentials: [web, central, telegram, deployer], audience: CONNECTORS_AUDIENCE,
  defaultTimeZone: "Etc/UTC", logLevel: "error",
};

type Caller = Readonly<{ credential: ServiceCredentialPolicy; actorType: "human" | "agent" | "service"; actorId?: string }>;
const human: Caller = { credential: web, actorType: "human" };
const agent: Caller = { credential: central, actorType: "agent" };

const authHeaders = async (caller: Caller, scopes: readonly ConnectorScope[]) => ({
  "x-pih-service-token": caller.credential.serviceToken,
  authorization: "Bearer " + await new SignJWT({
    actor_id: caller.actorId ?? OWNER, actor_type: caller.actorType, scope: [...scopes], request_id: "request-fictional",
  }).setProtectedHeader({ alg: "HS256" }).setIssuer(caller.credential.delegatedIssuer)
    .setAudience(CONNECTORS_AUDIENCE).setSubject("fictional-subject").setIssuedAt().setExpirationTime("30s")
    .sign(caller.credential.delegatedKey),
});

const calendarStatus: CalendarSourceStatus = {
  state: "available", checkedAt: NOW, stale: false, canRead: true, canProposeChanges: true,
  primaryCalendarConfigured: true, additionalCalendarCount: 0,
};
const selection: CalendarSelection = {
  version: 1,
  items: [{ calendarRef: "cal_fictional", displayName: "Fictional", accessRole: "owner", readEnabled: true, writeEnabled: true, isPrimary: true }],
};
const timed = { kind: "timed" as const, start: "2026-10-12T13:00:00.000Z", end: "2026-10-12T14:00:00.000Z", timeZone: "UTC" };
const agenda: CalendarAgenda = { timeZone: "UTC", from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", generatedAt: NOW, items: [] };
const eventDetail: CalendarEventDetail = {
  eventRef: "evt_fictional", calendarRef: "cal_fictional", calendarDisplayName: "Fictional", title: "Fictional meeting",
  time: timed, status: "confirmed", organizerRelationship: "self", attendees: [],
  recurrence: { recurring: false, instance: false }, updatedAt: NOW,
};
const eventList: CalendarEventList = { items: [eventDetail], pageInfo: {} };
const proposal: CalendarChangeProposal = {
  id: "00000000-0000-4000-8000-000000000001", version: 1, status: "pending",
  summary: {
    operation: "create", calendarDisplayName: "Fictional", timeZone: "UTC", recurrenceScope: "single",
    organizerRelationship: "self", guestNotification: "none", after: { title: "Fictional meeting", time: timed, attendeeCount: 0 },
  },
  createdAt: NOW, expiresAt: "2026-10-12T12:15:00.000Z",
};
const sourceStatus: SourceStatus = { id: "calendar", state: "available", checkedAt: NOW, stale: false, capabilities: [] };

type Call = Readonly<{ name: string; principal?: DelegatedPrincipal; args: readonly unknown[] }>;

/** Thin stub services: every handler must call exactly one of these and serialize its contract result. */
const stubDependencies = (calls: Call[], overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) => {
  const record = <T>(name: string, value: T) => async (principal: DelegatedPrincipal, ...args: unknown[]): Promise<T> => {
    calls.push({ name, principal, args });
    const override = overrides[name];
    return (override === undefined ? value : await override(principal, ...args)) as T;
  };
  const lifecycle = { started: 0, stopped: 0 };
  const dependencies: CalendarModuleDependencies = {
    oauth: {
      status: record("oauth.status", calendarStatus),
      start: record<CalendarAuthorizationStart>("oauth.start", { authorizationUrl: "https://accounts.google.test/authorize", expiresAt: "2026-10-12T12:10:00.000Z" }),
      callback: record("oauth.callback", calendarStatus),
      bootstrap: record("oauth.bootstrap", calendarStatus),
      disconnect: record("oauth.disconnect", { ...calendarStatus, state: "not_configured", canRead: false, canProposeChanges: false, primaryCalendarConfigured: false }),
    },
    selection: {
      discover: record("selection.discover", selection),
      get: record("selection.get", selection),
      update: record("selection.update", selection),
      bootstrapPrimary: async () => { throw new Error("not routed"); },
    },
    agenda: { read: record("agenda.read", agenda) },
    events: { list: record("events.list", eventList), get: record("events.get", eventDetail) },
    changes: {
      create: record("changes.create", proposal),
      get: record("changes.get", proposal),
      confirm: record("changes.confirm", { ...proposal, status: "completed", version: 3 }),
      reject: record("changes.reject", { ...proposal, status: "rejected", version: 2 }),
      reconcileExecuting: record("changes.reconcileExecuting", proposal),
    },
    sourceStatus: { read: async () => sourceStatus },
    lifecycle: {
      start: async () => { lifecycle.started += 1; },
      stop: async () => { lifecycle.stopped += 1; },
    },
  };
  return { dependencies, lifecycle };
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeTestDatabases();
});

const createApp = async (overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) => {
  const { db } = await openTestDatabase();
  const calls: Call[] = [];
  const { dependencies, lifecycle } = stubDependencies(calls, overrides);
  const logs: string[] = [];
  const app = await createConnectorsApp({
    config, database: db, clock: { now: () => new Date(NOW) }, idGenerator: { generate: () => "fictional-id" },
    modules: [createCalendarModule(dependencies)], requestIdFactory: () => REQUEST_ID,
    logger: { level: "info", stream: { write: (line: string) => { logs.push(line); } } } as never,
  });
  apps.push(app);
  return { app, calls, lifecycle, logs };
};

type Route = Readonly<{
  name: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  scope: ConnectorScope;
  services: readonly ConnectorServiceId[];
  call: string;
  body?: unknown;
  headers?: Record<string, string>;
}>;
const PROPOSAL_URL = `/v1/calendar/change-proposals/${proposal.id}`;
const QUERY = "from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-13T00%3A00%3A00.000Z&timeZone=UTC";
const BOTH = ["pih-web", "hermes-central"] as const;
const WEB = ["pih-web"] as const;
const routes: readonly Route[] = [
  { name: "status", method: "GET", url: "/v1/calendar/status", scope: "calendar:read", services: BOTH, call: "oauth.status" },
  { name: "agenda", method: "GET", url: `/v1/calendar/agenda?${QUERY}`, scope: "calendar:read", services: BOTH, call: "agenda.read" },
  { name: "events", method: "GET", url: `/v1/calendar/events?${QUERY}`, scope: "calendar:read", services: BOTH, call: "events.list" },
  { name: "event", method: "GET", url: "/v1/calendar/events/evt_fictional", scope: "calendar:read", services: BOTH, call: "events.get" },
  { name: "proposal get", method: "GET", url: PROPOSAL_URL, scope: "calendar:read", services: BOTH, call: "changes.get" },
  {
    name: "proposal create", method: "POST", url: "/v1/calendar/change-proposals", scope: "calendar:propose", services: BOTH,
    call: "changes.create", headers: { "idempotency-key": "fictional-key-0001" },
    body: { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" },
  },
  { name: "oauth start", method: "POST", url: "/v1/calendar/oauth/authorizations", scope: "calendar:configure", services: WEB, call: "oauth.start" },
  {
    name: "oauth callback", method: "POST", url: "/v1/calendar/oauth/callback", scope: "calendar:configure", services: WEB,
    call: "oauth.callback", body: { code: "fictional-code", state: "fictional-state" },
  },
  { name: "bootstrap", method: "POST", url: "/v1/calendar/bootstrap", scope: "calendar:configure", services: WEB, call: "oauth.bootstrap" },
  { name: "disconnect", method: "DELETE", url: "/v1/calendar/connection", scope: "calendar:configure", services: WEB, call: "oauth.disconnect" },
  { name: "calendars", method: "GET", url: "/v1/calendar/calendars", scope: "calendar:configure", services: WEB, call: "selection.discover" },
  { name: "selection get", method: "GET", url: "/v1/calendar/selection", scope: "calendar:configure", services: WEB, call: "selection.get" },
  {
    name: "selection put", method: "PUT", url: "/v1/calendar/selection", scope: "calendar:configure", services: WEB, call: "selection.update",
    body: { expectedVersion: 1, calendars: [{ calendarRef: "cal_fictional", readEnabled: true, writeEnabled: true }] },
  },
  { name: "confirm", method: "POST", url: `${PROPOSAL_URL}/confirmation`, scope: "calendar:confirm", services: WEB, call: "changes.confirm", body: { expectedVersion: 1 } },
  { name: "reject", method: "POST", url: `${PROPOSAL_URL}/rejection`, scope: "calendar:confirm", services: WEB, call: "changes.reject", body: { expectedVersion: 1 } },
  { name: "retry", method: "POST", url: `${PROPOSAL_URL}/reconciliation`, scope: "calendar:confirm", services: WEB, call: "changes.reconcileExecuting" },
];

const send = async (app: FastifyInstance, route: Route, headers: Record<string, string>, patch: Partial<Route> = {}) => {
  const target = { ...route, ...patch };
  return app.inject({
    method: target.method, url: target.url,
    headers: { ...headers, ...target.headers },
    ...(target.body === undefined ? {} : { payload: target.body as Record<string, unknown> }),
  });
};

const expectProblem = (response: Awaited<ReturnType<FastifyInstance["inject"]>>, status: number, code: string) => {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/u);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["x-request-id"]).toBe(REQUEST_ID);
  const problem = ApiProblemSchema.parse(response.json());
  expect(problem).toMatchObject({ status, code, requestId: REQUEST_ID });
  return problem;
};

describe("Calendar connector routes: authorization matrix", () => {
  for (const route of routes) {
    it(`${route.method} ${route.name}: ${route.services.join(", ")} with ${route.scope}`, async () => {
      const { app, calls } = await createApp();

      const ok = await send(app, route, await authHeaders(human, [route.scope]));
      expect(ok.statusCode).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.headers["x-request-id"]).toBe(REQUEST_ID);
      expect(calls.map((call) => call.name)).toEqual([route.call]);
      // The service receives the verified principal, never a caller-supplied identity.
      expect(calls[0]!.principal).toMatchObject({ serviceId: "pih-web", actorId: OWNER, actorType: "human", scopes: [route.scope] });

      if (route.services.includes("hermes-central")) {
        const agentResponse = await send(app, route, await authHeaders(agent, [route.scope]));
        expect(agentResponse.statusCode).toBe(200);
        expect(calls.at(-1)!.principal).toMatchObject({ serviceId: "hermes-central", actorId: OWNER, actorType: "agent" });
      } else {
        // Central holds read and propose at most; neither opens a configure or confirm route.
        expectProblem(await send(app, route, await authHeaders(agent, ["calendar:read", "calendar:propose"])), 403, "forbidden");
        // Central can never even present calendar:confirm or calendar:configure.
        expectProblem(await send(app, route, await authHeaders(agent, [route.scope])), 403, "forbidden");
      }
      const callsBefore = calls.length;
      // A pih-web human lacking the route scope.
      const otherScope: ConnectorScope = route.scope === "calendar:read" ? "calendar:propose" : "calendar:read";
      expectProblem(await send(app, route, await authHeaders(human, [otherScope, "system:read"])), 403, "forbidden");
      // Telegram and the deployer are rejected on every Calendar route.
      expectProblem(await send(app, route, await authHeaders({ credential: telegram, actorType: "service" }, ["hermes:conversations:read"])), 403, "forbidden");
      expectProblem(await send(app, route, await authHeaders({ credential: deployer, actorType: "service" }, ["health:read"])), 403, "forbidden");
      // Missing credentials.
      expectProblem(await send(app, route, {}), 401, "authentication_required");
      expect(calls).toHaveLength(callsBefore);
    });
  }

  it("rejects Central acting for an actor other than its bound owner before any handler runs", async () => {
    const { app, calls } = await createApp();
    for (const route of routes.filter((item) => item.services.includes("hermes-central"))) {
      expectProblem(await send(app, route, await authHeaders({ ...agent, actorId: STRANGER }, [route.scope])), 403, "forbidden");
    }
    expect(calls).toHaveLength(0);
  });

  it("never lets an agent confirm, reject or retry, even with a forged scope list", async () => {
    const { app, calls } = await createApp();
    for (const route of routes.filter((item) => item.scope === "calendar:confirm")) {
      expectProblem(await send(app, route, await authHeaders(agent, ["calendar:confirm"])), 403, "forbidden");
      expectProblem(await send(app, route, await authHeaders(agent, ["calendar:read", "calendar:propose", "calendar:confirm"])), 403, "forbidden");
      expectProblem(await send(app, route, await authHeaders(agent, ["calendar:propose"])), 403, "forbidden");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("Calendar connector routes: contracts and validation", () => {
  it("serializes strict contract results, including SourceStatus for disconnect", async () => {
    const { app } = await createApp();
    const status = await app.inject({ method: "GET", url: "/v1/calendar/status", headers: await authHeaders(human, ["calendar:read"]) });
    expect(CalendarSourceStatusSchema.parse(status.json())).toEqual(calendarStatus);
    const disconnect = await app.inject({ method: "DELETE", url: "/v1/calendar/connection", headers: await authHeaders(human, ["calendar:configure"]) });
    expect(SourceStatusSchema.parse(disconnect.json())).toMatchObject({ id: "calendar", state: "not_configured", stale: false, capabilities: [] });
    const created = await app.inject({
      method: "POST", url: "/v1/calendar/change-proposals",
      headers: { ...await authHeaders(agent, ["calendar:propose"]), "idempotency-key": "fictional-key-0002" },
      payload: { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" },
    });
    expect(CalendarChangeProposalSchema.parse(created.json())).toEqual(proposal);
    const agendaResponse = await app.inject({ method: "GET", url: `/v1/calendar/agenda?${QUERY}`, headers: await authHeaders(agent, ["calendar:read"]) });
    expect(CalendarAgendaSchema.parse(agendaResponse.json())).toEqual(agenda);
  });

  it("passes parsed inputs to exactly one service call", async () => {
    const { app, calls } = await createApp();
    await app.inject({
      method: "GET", url: `/v1/calendar/events?${QUERY}&cursor=fictional-cursor`, headers: await authHeaders(human, ["calendar:read"]),
    });
    expect(calls.at(-1)).toMatchObject({
      name: "events.list",
      args: [{ from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", timeZone: "UTC", cursor: "fictional-cursor" }],
    });
    await app.inject({
      method: "POST", url: "/v1/calendar/change-proposals",
      headers: { ...await authHeaders(agent, ["calendar:propose"]), "idempotency-key": "fictional-key-0003" },
      payload: { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" },
    });
    expect(calls.at(-1)).toMatchObject({
      name: "changes.create",
      args: ["fictional-key-0003", { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" }],
    });
    await app.inject({
      method: "POST", url: `${PROPOSAL_URL}/confirmation`, headers: await authHeaders(human, ["calendar:confirm"]), payload: { expectedVersion: 1 },
    });
    expect(calls.at(-1)).toMatchObject({ name: "changes.confirm", args: [proposal.id, { expectedVersion: 1 }] });
  });

  const invalid: ReadonlyArray<readonly [string, Partial<Route>, ConnectorScope, string?]> = [
    ["agenda without timeZone", { method: "GET", url: "/v1/calendar/agenda?from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-13T00%3A00%3A00.000Z" }, "calendar:read"],
    ["agenda with an unknown parameter", { method: "GET", url: `/v1/calendar/agenda?${QUERY}&calendarId=raw` }, "calendar:read"],
    ["agenda with a repeated parameter", { method: "GET", url: `/v1/calendar/agenda?${QUERY}&timeZone=UTC` }, "calendar:read"],
    ["agenda with a reversed window", { method: "GET", url: "/v1/calendar/agenda?from=2026-10-13T00%3A00%3A00.000Z&to=2026-10-12T00%3A00%3A00.000Z&timeZone=UTC" }, "calendar:read"],
    ["status with a query", { method: "GET", url: "/v1/calendar/status?verbose=1" }, "calendar:read"],
    ["selection with an unknown field", { method: "PUT", url: "/v1/calendar/selection", body: { expectedVersion: 1, calendars: [], providerId: "raw" } }, "calendar:configure"],
    ["callback with an unknown field", { method: "POST", url: "/v1/calendar/oauth/callback", body: { code: "c", state: "s", redirect: "https://elsewhere.test" } }, "calendar:configure"],
    ["bootstrap with a body", { method: "POST", url: "/v1/calendar/bootstrap", body: { force: true } }, "calendar:configure"],
    ["confirmation without a version", { method: "POST", url: `${PROPOSAL_URL}/confirmation`, body: {} }, "calendar:confirm"],
    ["proposal with an unknown operation", {
      method: "POST", url: "/v1/calendar/change-proposals", headers: { "idempotency-key": "fictional-key-0004" }, body: { operation: "delete" },
    }, "calendar:propose"],
    ["proposal without an idempotency key", {
      method: "POST", url: "/v1/calendar/change-proposals",
      body: { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" },
    }, "calendar:propose", "idempotency_key_required"],
  ];
  for (const [name, patch, scope, code] of invalid) {
    it(`rejects ${name} before any service call`, async () => {
      const { app, calls } = await createApp();
      const route: Route = { name, method: "GET", url: "/", scope, services: WEB, call: "none" };
      const response = await send(app, route, await authHeaders(human, [scope]), patch);
      expectProblem(response, 400, code ?? "validation_failed");
      expect(calls).toHaveLength(0);
    });
  }

  it("rejects an oversized path reference before routing", async () => {
    const { app, calls } = await createApp();
    const response = await app.inject({ method: "GET", url: `/v1/calendar/events/${"e".repeat(300)}`, headers: await authHeaders(human, ["calendar:read"]) });
    // Fastify's router refuses parameters beyond maxParamLength before authentication runs; the
    // response is the framework's (a foundation concern), and no Calendar handler is reached.
    expect(response.statusCode).toBe(414);
    expect(calls).toHaveLength(0);
  });

  it("rejects a repeated idempotency key header", async () => {
    const { app, calls } = await createApp();
    const response = await app.inject({
      method: "POST", url: "/v1/calendar/change-proposals",
      headers: { ...await authHeaders(agent, ["calendar:propose"]), "idempotency-key": ["fictional-key-0005", "fictional-key-0006"] },
      payload: { operation: "cancel", eventRef: "evt_fictional", recurrenceScope: "single", guestNotification: "none" },
    });
    expectProblem(response, 400, "validation_failed");
    expect(calls).toHaveLength(0);
  });

  it("treats a service result that violates its contract as an internal error without leaking it", async () => {
    const { app } = await createApp({ "agenda.read": () => ({ ...agenda, items: [{ secret: "provider-raw-payload" }] }) });
    const response = await app.inject({ method: "GET", url: `/v1/calendar/agenda?${QUERY}`, headers: await authHeaders(human, ["calendar:read"]) });
    expectProblem(response, 500, "internal_error");
    expect(response.body).not.toContain("provider-raw-payload");
  });
});

describe("Calendar connector routes: problem mapping", () => {
  const mapping: ReadonlyArray<readonly [string, number, string]> = [
    ["forbidden", 403, "forbidden"],
    ["calendar_result_too_large", 413, "payload_too_large"],
    ["calendar_cursor_expired", 410, "cursor_expired"],
    ["proposal_content_purged", 410, "not_found"],
    ["idempotency_conflict", 409, "idempotency_key_reused"],
    ["idempotency_key_invalid", 400, "validation_failed"],
    ["calendar_query_invalid", 400, "validation_failed"],
    ["calendar_range_too_large", 400, "validation_failed"],
    ["calendar_proposal_invalid", 400, "validation_failed"],
    ["calendar_selection_invalid", 400, "validation_failed"],
    ["calendar_selection_primary_required", 400, "validation_failed"],
    ["calendar_write_requires_read_selection", 400, "validation_failed"],
    ["calendar_recurrence_scope_invalid", 400, "validation_failed"],
    ["calendar_oauth_state_invalid", 400, "validation_failed"],
    ["calendar_oauth_required_scope_missing", 400, "validation_failed"],
    ["calendar_event_not_found", 404, "not_found"],
    ["calendar_proposal_not_found", 404, "not_found"],
    ["calendar_not_found", 404, "not_found"],
    ["update_not_permitted", 403, "forbidden"],
    ["cancel_not_permitted", 403, "forbidden"],
    ["invitation_response_not_permitted", 403, "forbidden"],
    ["calendar_not_writable", 403, "forbidden"],
    ["calendar_write_not_permitted", 403, "forbidden"],
    ["calendar_provider_permission_denied", 403, "forbidden"],
    ["calendar_proposal_version_conflict", 409, "version_conflict"],
    ["calendar_selection_version_conflict", 409, "version_conflict"],
    ["calendar_proposal_not_pending", 409, "conflict"],
    ["calendar_connection_changed", 409, "conflict"],
    ["calendar_provider_conflict", 409, "conflict"],
    ["calendar_not_configured", 409, "conflict"],
    ["calendar_reauthorization_required", 409, "conflict"],
    ["calendar_primary_unavailable", 409, "conflict"],
    ["calendar_oauth_refresh_token_missing", 409, "conflict"],
    ["calendar_provider_temporarily_unavailable", 503, "dependency_unavailable"],
    ["calendar_provider_request_failed", 502, "dependency_unavailable"],
    ["calendar_provider_response_invalid", 502, "dependency_unavailable"],
    ["calendar_oauth_exchange_failed", 502, "dependency_unavailable"],
    ["calendar_access_token_invalidated", 503, "dependency_unavailable"],
    ["calendar_primary_bootstrap_failed", 503, "dependency_unavailable"],
    ["calendar_selection_update_failed", 503, "dependency_unavailable"],
    ["calendar_credentials_unavailable", 500, "internal_error"],
    ["calendar_disconnect_failed", 500, "internal_error"],
  ];
  for (const [serviceCode, status, code] of mapping) {
    it(`maps ${serviceCode} to ${status} ${code}`, async () => {
      const { app } = await createApp({ "agenda.read": () => { throw new Error(serviceCode); } });
      const response = await app.inject({ method: "GET", url: `/v1/calendar/agenda?${QUERY}`, headers: await authHeaders(human, ["calendar:read"]) });
      const problem = expectProblem(response, status, code);
      expect(problem.instance).toBe("/v1/calendar/agenda");
      // The internal code is a closed-set detail: it never reaches the caller.
      if (serviceCode !== code) expect(response.body).not.toContain(serviceCode);
    });
  }

  it("closes unknown errors as internal errors without messages, stacks or provider payloads", async () => {
    const secret = "fictional-refresh-token-value at Object.<anonymous> (/srv/connectors/src/calendar.ts:1:1)";
    const { app, logs } = await createApp({ "agenda.read": () => { throw new Error(secret); } });
    const response = await app.inject({ method: "GET", url: `/v1/calendar/agenda?${QUERY}`, headers: await authHeaders(human, ["calendar:read"]) });
    expectProblem(response, 500, "internal_error");
    expect(response.body).not.toMatch(/fictional-refresh-token|stack|\/srv\//u);
    expect(logs.join("\n")).not.toMatch(/fictional-refresh-token|\/srv\//u);
    expect(logs.join("\n")).toContain("internal_error");
  });

  it("does not map look-alike error subclasses or Fastify errors by message", async () => {
    class ProviderError extends Error {}
    const { app } = await createApp({ "agenda.read": () => { throw new ProviderError("calendar_not_found"); } });
    const response = await app.inject({ method: "GET", url: `/v1/calendar/agenda?${QUERY}`, headers: await authHeaders(human, ["calendar:read"]) });
    expectProblem(response, 500, "internal_error");
  });

  it("keeps foundation problems for oversized and malformed bodies", async () => {
    const { app } = await createApp();
    const headers = { ...await authHeaders(human, ["calendar:configure"]), "content-type": "application/json" };
    expectProblem(await app.inject({ method: "PUT", url: "/v1/calendar/selection", headers, payload: "{" }), 400, "validation_failed");
    expectProblem(await app.inject({
      method: "PUT", url: "/v1/calendar/selection", headers, payload: JSON.stringify({ pad: "x".repeat(1_100_000) }),
    }), 413, "payload_too_large");
  });
});

describe("Calendar connector module lifecycle", () => {
  it("starts maintenance before routes are served and stops it when the app closes", async () => {
    const { app, lifecycle } = await createApp();
    expect(lifecycle).toEqual({ started: 1, stopped: 0 });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(lifecycle).toEqual({ started: 1, stopped: 1 });
  });
});
