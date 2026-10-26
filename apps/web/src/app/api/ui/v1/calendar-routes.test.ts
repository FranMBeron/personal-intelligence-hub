// @vitest-environment node

import {
  agendaFixture,
  calendarSelectionFixture,
  calendarStatusFixture,
  proposalFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it, vi } from "vitest";

import type { RequestIdentityAdapter, VerifiedPrincipal } from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { GatewayError } from "../../../../server/problems";
import type { CalendarGateway } from "../../../../server/ports/calendar-gateway";
import {
  createCalendarAgendaHandler,
  createCalendarBootstrapHandler,
  createCalendarCalendarsHandler,
  createCalendarConfirmationHandler,
  createCalendarDisconnectHandler,
  createCalendarEventHandler,
  createCalendarEventsHandler,
  createCalendarOAuthCallbackHandler,
  createCalendarProposalHandler,
  createCalendarProposeHandler,
  createCalendarRejectionHandler,
  createCalendarSelectionHandler,
  createCalendarStartAuthorizationHandler,
  createCalendarStatusHandler,
  createUpdateCalendarSelectionHandler,
} from "./_lib/calendar-handlers";
import type { RequestPolicy } from "./_lib/request-guards";

const ORIGIN = "https://app.example.test";
const REQUEST_ID = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const human: VerifiedPrincipal = {
  actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  subject: "user:fictional@example.test",
  actorType: "human",
};

const identityFor = (principal: VerifiedPrincipal | undefined): RequestIdentityAdapter => ({
  async resolve(headers) {
    const authorization = headers.get("authorization");
    if (authorization === null || !/^Bearer\s+\S+$/iu.test(authorization)) {
      return { ok: false, status: 401, title: "Authentication required", detail: "A bearer token is required." };
    }
    return {
      ok: true,
      authorization,
      concurrencyKey: "oidc:fictional-human",
      ...(principal === undefined ? {} : { principal }),
    };
  },
});

const policyFor = (principal: VerifiedPrincipal | undefined): RequestPolicy => ({
  publicOrigin: ORIGIN,
  identity: identityFor(principal),
  maxUploadBodyBytes: 1_048_576,
  agentConcurrency: new IdentityConcurrencyLimiter(2),
  agentRateLimit: null,
});
const policy = policyFor(human);

const baseHeaders = (values: Record<string, string> = {}): Headers => {
  const headers = new Headers({
    authorization: "Bearer delegated-test-token",
    origin: ORIGIN,
    "content-type": "application/json",
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === "") headers.delete(key);
    else headers.set(key, value);
  }
  return headers;
};

const call = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(`${ORIGIN}/api/ui/v1/calendar${path}`, {
    method,
    headers: baseHeaders(headers),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const params = <K extends string>(values: Record<K, string>) => ({ params: Promise.resolve(values) });

const problemError = (status: number, code: "version_conflict" | "conflict" | "not_found" | "forbidden" | "validation_failed", title = "Upstream problem") =>
  new GatewayError({
    type: "about:blank",
    title,
    status,
    detail: "A safe upstream detail.",
    instance: "/api/ui/v1/calendar",
    code,
    requestId: REQUEST_ID,
  });

const gatewayStub = (overrides: Partial<CalendarGateway> = {}): CalendarGateway => ({
  status: vi.fn(async () => calendarStatusFixture()),
  startAuthorization: vi.fn(async () => ({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fictional&state=fictional",
    expiresAt: "2026-10-12T12:10:00.000Z",
  })),
  completeAuthorization: vi.fn(async () => calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true })),
  bootstrap: vi.fn(async () => calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true })),
  disconnect: vi.fn(async () => sourceStatusFixture({ id: "calendar", state: "not_configured" })),
  calendars: vi.fn(async () => calendarSelectionFixture()),
  selection: vi.fn(async () => calendarSelectionFixture({ version: 3 })),
  updateSelection: vi.fn(async () => calendarSelectionFixture({ version: 4 })),
  agenda: vi.fn(async () => agendaFixture()),
  events: vi.fn(async () => ({ items: [], pageInfo: {} })),
  event: vi.fn(async () => ({
    eventRef: "event-ref-1",
    calendarRef: "calendar-ref-1",
    calendarDisplayName: "Fictional calendar",
    title: "Fictional event",
    time: { kind: "timed" as const, start: "2026-10-12T13:00:00.000Z", end: "2026-10-12T14:00:00.000Z", timeZone: "Etc/UTC" },
    status: "confirmed" as const,
    organizerRelationship: "self" as const,
    attendees: [],
    recurrence: { recurring: false, instance: false },
    updatedAt: "2026-10-12T12:00:00.000Z",
  })),
  propose: vi.fn(async () => proposalFixture()),
  proposal: vi.fn(async () => proposalFixture()),
  confirm: vi.fn(async () => proposalFixture({ status: "completed", version: 1, completedAt: "2026-10-12T12:05:00.000Z" })),
  reject: vi.fn(async () => proposalFixture({ status: "rejected", version: 1 })),
  ...overrides,
});

const callbackRequest = (query: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/ui/v1/calendar/oauth/callback?${query}`, {
    headers: baseHeaders({ origin: "", "content-type": "", ...headers }),
  });

describe("calendar OAuth callback", () => {
  it("never redirects an OAuth callback to a query-supplied host", async () => {
    const gateway = gatewayStub();
    const callback = createCalendarOAuthCallbackHandler(gateway, policy);
    const response = await callback(callbackRequest("code=fake&state=fake&returnTo=https://other.example.test&redirect_uri=https://other.example.test"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/system?calendar=connected");
    expect(response.headers.get("location")).not.toContain("other.example.test");
    expect(await response.text()).not.toContain("refresh_token");
  });

  it("forwards only code and state for the authenticated initiating human and sets safe headers", async () => {
    const gateway = gatewayStub();
    const callback = createCalendarOAuthCallbackHandler(gateway, policy);
    const response = await callback(callbackRequest("code=fictional-code&state=fictional-state&scope=x&extra=y"));
    expect(gateway.completeAuthorization).toHaveBeenCalledTimes(1);
    expect(gateway.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ principal: human }),
      { code: "fictional-code", state: "fictional-state" },
      expect.any(AbortSignal),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const visible = (await response.text()) + JSON.stringify([...response.headers]);
    expect(visible).not.toContain("fictional-code");
    expect(visible).not.toContain("fictional-state");
  });

  it("does not require the mutation Origin header because state is verified by connectors", async () => {
    const gateway = gatewayStub();
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("code=fictional-code&state=fictional-state", { origin: "" }),
    );
    expect(response.headers.get("location")).toBe("/system?calendar=connected");
  });

  it.each([
    ["state mismatch", problemError(403, "forbidden", "OAuth state rejected")],
    ["replayed state", problemError(409, "conflict", "OAuth state already used")],
    ["expired state", problemError(422, "validation_failed", "OAuth state expired")],
  ])("redirects a %s only to the fixed attention page", async (_name, failure) => {
    const gateway = gatewayStub({ completeAuthorization: vi.fn(async () => { throw failure; }) });
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("code=fictional-code&state=fictional-state"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/system?calendar=attention");
    expect(await response.text()).toBe("");
  });

  it("returns attention without exchanging when the provider reports a denial", async () => {
    const gateway = gatewayStub();
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("error=access_denied&state=fictional-state&code=fictional-code"),
    );
    expect(response.headers.get("location")).toBe("/system?calendar=attention");
    expect(gateway.completeAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["missing code", "state=fictional-state"],
    ["missing state", "code=fictional-code"],
    ["empty code", "code=&state=fictional-state"],
    ["repeated code", "code=a-code&code=b-code&state=fictional-state"],
    ["repeated state", "code=a-code&state=s1&state=s2"],
    ["control characters", "code=a%0Acode&state=fictional-state"],
    ["oversized code", `code=${"c".repeat(4097)}&state=fictional-state`],
  ])("rejects a callback with %s without contacting connectors", async (_name, query) => {
    const gateway = gatewayStub();
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(callbackRequest(query));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/system?calendar=attention");
    expect(gateway.completeAuthorization).not.toHaveBeenCalled();
  });

  it("fails closed without a verified human identity", async () => {
    const gateway = gatewayStub();
    const unauthenticated = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("code=fictional-code&state=fictional-state", { authorization: "" }),
    );
    expect(unauthenticated.headers.get("location")).toBe("/system?calendar=attention");
    const noPrincipal = await createCalendarOAuthCallbackHandler(gateway, policyFor(undefined))(
      callbackRequest("code=fictional-code&state=fictional-state"),
    );
    expect(noPrincipal.headers.get("location")).toBe("/system?calendar=attention");
    expect(gateway.completeAuthorization).not.toHaveBeenCalled();
  });

  it("redirects requires_attention to the attention page and an unconfigured gateway safely", async () => {
    const gateway = gatewayStub({
      completeAuthorization: vi.fn(async () => calendarStatusFixture({ state: "requires_attention", safeReasonCode: "calendar_selection_required" })),
    });
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("code=fictional-code&state=fictional-state"),
    );
    expect(response.headers.get("location")).toBe("/system?calendar=attention");
    const unconfigured = await createCalendarOAuthCallbackHandler(null, policy)(
      callbackRequest("code=fictional-code&state=fictional-state"),
    );
    expect(unconfigured.headers.get("location")).toBe("/system?calendar=attention");
  });

  it("does not leak an unexpected upstream payload through the redirect", async () => {
    const gateway = gatewayStub({
      completeAuthorization: vi.fn(async () => ({ state: "available", refresh_token: "leak" }) as never),
    });
    const response = await createCalendarOAuthCallbackHandler(gateway, policy)(
      callbackRequest("code=fictional-code&state=fictional-state"),
    );
    expect(response.headers.get("location")).toBe("/system?calendar=attention");
    expect(await response.text()).not.toContain("leak");
  });
});

describe("calendar bootstrap after requires_attention", () => {
  it("retries only primary discovery and converges without another code exchange", async () => {
    let attempts = 0;
    const gateway = gatewayStub({
      completeAuthorization: vi.fn(async () => calendarStatusFixture({ state: "requires_attention", safeReasonCode: "calendar_selection_required" })),
      bootstrap: vi.fn(async () => {
        attempts += 1;
        return attempts === 1
          ? calendarStatusFixture({ state: "requires_attention", safeReasonCode: "provider_temporarily_unavailable" })
          : calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true });
      }),
    });
    await createCalendarOAuthCallbackHandler(gateway, policy)(callbackRequest("code=fictional-code&state=fictional-state"));
    const bootstrap = createCalendarBootstrapHandler(gateway, policy);
    const first = await bootstrap(call("/bootstrap", "POST"));
    expect((await first.json()).state).toBe("requires_attention");
    const second = await bootstrap(call("/bootstrap", "POST"));
    expect(second.status).toBe(200);
    expect((await second.json()).state).toBe("available");
    expect(gateway.completeAuthorization).toHaveBeenCalledTimes(1);
    expect(gateway.bootstrap).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "https://other.example.test"])("requires the application Origin (%s)", async (origin) => {
    const gateway = gatewayStub();
    const response = await createCalendarBootstrapHandler(gateway, policy)(
      call("/bootstrap", "POST", undefined, { origin: origin ?? "" }),
    );
    expect(response.status).toBe(403);
    expect(gateway.bootstrap).not.toHaveBeenCalled();
  });
});

describe("calendar authorization start", () => {
  it("returns an approved Google authorization link to the same-origin human", async () => {
    const gateway = gatewayStub();
    const response = await createCalendarStartAuthorizationHandler(gateway, policy)(call("/oauth/authorizations", "POST"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(new URL(body.authorizationUrl).host).toBe("accounts.google.com");
  });

  it.each([
    "https://other.example.test/o/oauth2/v2/auth?state=x",
    "https://accounts.google.com.other.example.test/o/oauth2/v2/auth",
    "https://accounts.google.com/logout",
    "https://user:pass@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com:8443/o/oauth2/v2/auth",
  ])("refuses to hand an unapproved upstream link to the browser: %s", async (authorizationUrl) => {
    const gateway = gatewayStub({
      startAuthorization: vi.fn(async () => ({ authorizationUrl, expiresAt: "2026-10-12T12:10:00.000Z" })),
    });
    const response = await createCalendarStartAuthorizationHandler(gateway, policy)(call("/oauth/authorizations", "POST"));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("other.example.test");
  });

  it.each([
    "https://evilgoogle.com/o/oauth2/v2/auth?client_id=fictional&state=fictional",
    "https://accounts.google.com.evil.test/o/oauth2/v2/auth?client_id=fictional&state=fictional",
  ])("refuses a look-alike Google host instead of matching by prefix or suffix: %s", async (authorizationUrl) => {
    const gateway = gatewayStub({
      startAuthorization: vi.fn(async () => ({ authorizationUrl, expiresAt: "2026-10-12T12:10:00.000Z" })),
    });
    const response = await createCalendarStartAuthorizationHandler(gateway, policy)(call("/oauth/authorizations", "POST"));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("evil");
  });

  it("requires same Origin and a verified human", async () => {
    const gateway = gatewayStub();
    const foreign = await createCalendarStartAuthorizationHandler(gateway, policy)(
      call("/oauth/authorizations", "POST", undefined, { origin: "https://other.example.test" }),
    );
    expect(foreign.status).toBe(403);
    const anonymous = await createCalendarStartAuthorizationHandler(gateway, policy)(
      call("/oauth/authorizations", "POST", undefined, { authorization: "" }),
    );
    expect(anonymous.status).toBe(401);
    const unverified = await createCalendarStartAuthorizationHandler(gateway, policyFor(undefined))(
      call("/oauth/authorizations", "POST"),
    );
    expect(unverified.status).toBe(401);
    expect(gateway.startAuthorization).not.toHaveBeenCalled();
  });
});

describe("calendar reads", () => {
  const window = "from=2026-10-12T00:00:00.000Z&to=2026-10-13T00:00:00.000Z&timeZone=Etc%2FUTC";

  it("serves status, discovery and selection as no-store reads", async () => {
    const gateway = gatewayStub();
    for (const [handler, path] of [
      [createCalendarStatusHandler(gateway, policy), "/status"],
      [createCalendarCalendarsHandler(gateway, policy), "/calendars"],
      [createCalendarSelectionHandler(gateway, policy), "/selection"],
    ] as const) {
      const response = await handler(call(path, "GET", undefined, { origin: "" }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const rejected = await handler(call(`${path}?debug=1`));
      expect(rejected.status).toBe(422);
    }
    expect(gateway.status).toHaveBeenCalledTimes(1);
    expect(gateway.calendars).toHaveBeenCalledTimes(1);
    expect(gateway.selection).toHaveBeenCalledTimes(1);
  });

  it("returns 501 when Calendar is not configured and 401 without identity", async () => {
    const unconfigured = await createCalendarStatusHandler(null, policy)(call("/status"));
    // Not configured is permanent for this deployment (501); a configured but failing gateway stays 503.
    expect(unconfigured.status).toBe(501);
    expect(await unconfigured.json()).toMatchObject({ status: 501, code: "dependency_unavailable" });
    const anonymous = await createCalendarStatusHandler(gatewayStub(), policy)(call("/status", "GET", undefined, { authorization: "" }));
    expect(anonymous.status).toBe(401);
  });

  it("forwards a valid agenda window", async () => {
    const gateway = gatewayStub();
    const response = await createCalendarAgendaHandler(gateway, policy)(call(`/agenda?${window}`));
    expect(response.status).toBe(200);
    expect(gateway.agenda).toHaveBeenCalledWith(
      expect.objectContaining({ principal: human }),
      { from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", timeZone: "Etc/UTC" },
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["inverted range", "from=2026-10-13T00:00:00.000Z&to=2026-10-12T00:00:00.000Z&timeZone=Etc%2FUTC"],
    ["unbounded range", "from=2026-01-01T00:00:00.000Z&to=2028-01-01T00:00:00.000Z&timeZone=Etc%2FUTC"],
    ["invalid zone", "from=2026-10-12T00:00:00.000Z&to=2026-10-13T00:00:00.000Z&timeZone=Mars%2FBase"],
    ["unknown key", `${window}&calendarId=private`],
    ["missing zone", "from=2026-10-12T00:00:00.000Z&to=2026-10-13T00:00:00.000Z"],
  ])("rejects an agenda/events query with %s", async (_name, query) => {
    const gateway = gatewayStub();
    expect((await createCalendarAgendaHandler(gateway, policy)(call(`/agenda?${query}`))).status).toBe(422);
    expect((await createCalendarEventsHandler(gateway, policy)(call(`/events?${query}`))).status).toBe(422);
    expect(gateway.agenda).not.toHaveBeenCalled();
    expect(gateway.events).not.toHaveBeenCalled();
  });

  it("forwards events with an opaque cursor and reads one opaque event reference", async () => {
    const gateway = gatewayStub();
    const list = await createCalendarEventsHandler(gateway, policy)(call(`/events?${window}&cursor=opaque-cursor`));
    expect(list.status).toBe(200);
    expect(gateway.events).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cursor: "opaque-cursor" }), expect.any(AbortSignal));
    const detail = await createCalendarEventHandler(gateway, policy)(call("/events/event-ref-1"), params({ eventRef: "event-ref-1" }));
    expect(detail.status).toBe(200);
    expect(gateway.event).toHaveBeenCalledWith(expect.anything(), "event-ref-1", expect.any(AbortSignal));
  });
});

describe("calendar selection writes", () => {
  const body = { expectedVersion: 3, calendars: [{ calendarRef: "calendar-ref-1", readEnabled: true, writeEnabled: false }] };

  it("forwards expectedVersion unchanged and preserves a 409 version conflict", async () => {
    const gateway = gatewayStub({ updateSelection: vi.fn(async () => { throw problemError(409, "version_conflict"); }) });
    const response = await createUpdateCalendarSelectionHandler(gateway, policy)(call("/selection", "PUT", body));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("version_conflict");
    expect(gateway.updateSelection).toHaveBeenCalledWith(expect.anything(), body, expect.any(AbortSignal));
  });

  it("rejects foreign Origin and malformed bodies before the gateway", async () => {
    const gateway = gatewayStub();
    const handler = createUpdateCalendarSelectionHandler(gateway, policy);
    expect((await handler(call("/selection", "PUT", body, { origin: "https://other.example.test" }))).status).toBe(403);
    expect((await handler(call("/selection", "PUT", { ...body, force: true }))).status).toBe(422);
    expect(gateway.updateSelection).not.toHaveBeenCalled();
  });
});

describe("calendar disconnect", () => {
  it("is a same-origin human mutation returning a normalized source status", async () => {
    const gateway = gatewayStub();
    const handler = createCalendarDisconnectHandler(gateway, policy);
    expect((await handler(call("/connection", "DELETE", undefined, { origin: "" }))).status).toBe(403);
    const response = await handler(call("/connection", "DELETE"));
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("not_configured");
    expect(gateway.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("calendar change proposals and human confirmation", () => {
  const createBody = {
    operation: "cancel",
    eventRef: "event-ref-1",
    recurrenceScope: "single",
    guestNotification: "none",
  };

  it("creates a proposal only with an idempotency key and never implies execution", async () => {
    const gateway = gatewayStub();
    const handler = createCalendarProposeHandler(gateway, policy);
    const missingKey = await handler(call("/change-proposals", "POST", createBody));
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).code).toBe("idempotency_key_required");
    const response = await handler(call("/change-proposals", "POST", createBody, { "idempotency-key": "proposal-key-0001" }));
    expect(response.status).toBe(201);
    expect((await response.json()).status).toBe("pending");
    expect(gateway.propose).toHaveBeenCalledWith(expect.anything(), "proposal-key-0001", createBody, expect.any(AbortSignal));
    expect(gateway.confirm).not.toHaveBeenCalled();
  });

  it("proposal lookup alone never grants confirmation", async () => {
    const gateway = gatewayStub();
    const response = await createCalendarProposalHandler(gateway, policy)(
      call("/change-proposals/fictional-proposal"), params({ proposalId: "fictional-proposal" }),
    );
    expect(response.status).toBe(200);
    expect(gateway.proposal).toHaveBeenCalledTimes(1);
    expect(gateway.confirm).not.toHaveBeenCalled();
    expect(gateway.reject).not.toHaveBeenCalled();
  });

  it("requires a verified human and same Origin for confirmation and rejection", async () => {
    for (const factory of [createCalendarConfirmationHandler, createCalendarRejectionHandler]) {
      const gateway = gatewayStub();
      const route = params({ proposalId: "fictional-proposal" });
      const unverified = await factory(gateway, policyFor(undefined))(call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }), route);
      expect(unverified.status).toBe(401);
      const foreign = await factory(gateway, policy)(call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }, { origin: "https://other.example.test" }), route);
      expect(foreign.status).toBe(403);
      const freeText = await factory(gateway, policy)(call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0, confirm: "yes please" }), route);
      expect(freeText.status).toBe(422);
      expect(gateway.confirm).not.toHaveBeenCalled();
      expect(gateway.reject).not.toHaveBeenCalled();
    }
  });

  it("forwards duplicate confirmation clicks unchanged so provider idempotency decides", async () => {
    const completed = proposalFixture({ status: "completed", version: 1, completedAt: "2026-10-12T12:05:00.000Z" });
    const gateway = gatewayStub({ confirm: vi.fn(async () => completed) });
    const handler = createCalendarConfirmationHandler(gateway, policy);
    const route = () => params({ proposalId: "fictional-proposal" });
    const first = await handler(call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }), route());
    const second = await handler(call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }), route());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(gateway.confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ principal: human }), "fictional-proposal", { expectedVersion: 0 }, expect.any(AbortSignal));
    expect(gateway.confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({ principal: human }), "fictional-proposal", { expectedVersion: 0 }, expect.any(AbortSignal));
  });

  it.each([
    [409, "version_conflict"],
    [409, "conflict"],
    [404, "not_found"],
    [422, "validation_failed"],
  ] as const)("keeps a %s %s confirmation failure distinct", async (status, code) => {
    const gateway = gatewayStub({ confirm: vi.fn(async () => { throw problemError(status, code); }) });
    const response = await createCalendarConfirmationHandler(gateway, policy)(
      call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }),
      params({ proposalId: "fictional-proposal" }),
    );
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });

  it("returns expired and rejected proposals as their own states, not success", async () => {
    const gateway = gatewayStub({
      confirm: vi.fn(async () => proposalFixture({ status: "expired", version: 1, safeReasonCode: "proposal_expired" })),
    });
    const response = await createCalendarConfirmationHandler(gateway, policy)(
      call("/change-proposals/fictional-proposal/confirmation", "POST", { expectedVersion: 0 }),
      params({ proposalId: "fictional-proposal" }),
    );
    expect((await response.json()).status).toBe("expired");
    const rejected = await createCalendarRejectionHandler(gatewayStub(), policy)(
      call("/change-proposals/fictional-proposal/rejection", "POST", { expectedVersion: 0 }),
      params({ proposalId: "fictional-proposal" }),
    );
    expect((await rejected.json()).status).toBe("rejected");
  });
});
