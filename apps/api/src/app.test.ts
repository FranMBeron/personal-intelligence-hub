import type { Principal } from "@personal-intelligence-hub/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  ApplicationError,
  AuthenticationRequiredError,
  ConflictError,
  CursorExpiredError,
  DependencyUnavailableError,
  ForbiddenError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InvalidCursorError,
  InvalidTokenError,
  NotFoundError,
  PreconditionRequiredError,
  ValidationError,
  VersionConflictError,
} from "./application/errors.js";
import type { Authenticator } from "./application/ports/authenticator.js";
import type { QueryPorts } from "./application/ports/queries.js";
import type {
  MutationPorts,
  TransactionPorts,
} from "./application/ports/unit-of-work.js";
import { InMemoryUnitOfWork } from "./adapters/testing/in-memory-unit-of-work.js";
import type { PublicConfig } from "./config/public.js";
import { toApiProblem } from "./errors.js";

const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";

const principal: Principal = {
  subject: "test-subject",
  actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  actorType: "human",
  scopes: ["second-brain:read", "second-brain:write"],
  allowedSources: ["test"],
};

const publicConfig: PublicConfig = {
  apiVersion: "v1",
  productName: "Personal Intelligence Hub",
  oidcIssuer: "https://identity.example.test",
  oidcClientId: "pih-web",
  enabledUiCapabilities: ["second-brain"],
};

class FakeAuthenticator implements Authenticator {
  readonly kind = "test" as const;

  constructor(private readonly result: Principal = principal) {}

  async authenticate(token: string): Promise<Principal> {
    if (token !== "valid-token") {
      throw new Error("invalid test credential");
    }
    return this.result;
  }
}

const queries: QueryPorts = {
  boards: {
    list: vi.fn(),
    get: vi.fn(),
  },
  cards: {
    get: vi.fn(),
  },
  tasks: {
    list: vi.fn(),
  },
  auditEvents: {
    list: vi.fn(),
  },
  snapshot: {
    get: vi.fn(),
  },
};

const mutations = {} as MutationPorts;
const transactionPorts: TransactionPorts = { mutations, queries };

const makeApp = (
  authenticator: Authenticator = new FakeAuthenticator(),
  config: PublicConfig = publicConfig,
  bodyLimit = 1_048_576,
) =>
  buildApp({
    authenticator,
    cursorCodec: {
      encode: vi.fn(),
      decode: vi.fn(),
    },
    unitOfWork: new InMemoryUnitOfWork(transactionPorts),
    queries,
    readinessCheck: async () => ({ status: "ready" }),
    clock: () => new Date("2026-09-15T12:00:00.000Z"),
    requestIdFactory: () => requestId,
    publicConfig: config,
    runtime: "test",
    bodyLimit,
    logger: false,
  });

const expectedProblem = (
  code: string,
  title: string,
  status: number,
  detail: string,
  instance: string,
) => ({
  type: `https://pih.example/problems/${code.replaceAll("_", "-")}`,
  title,
  status,
  detail,
  instance,
  code,
  requestId,
});

describe("API foundation", () => {
  const apps: Array<ReturnType<typeof makeApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  test("keeps liveness anonymous and echoes the generated request ID", async () => {
    const app = makeApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBe(requestId);
  });

  test("rejects anonymous readiness with the exact problem envelope", async () => {
    const app = makeApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/,
    );
    expect(response.json()).toEqual(
      expectedProblem(
        "authentication_required",
        "Authentication required",
        401,
        "A bearer token is required.",
        "/health/ready",
      ),
    );
  });

  test("requires a read scope on the public-config route", async () => {
    const withoutRead: Principal = {
      ...principal,
      scopes: ["second-brain:write"],
    };
    const app = makeApp(new FakeAuthenticator(withoutRead));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/config/public",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(
      expectedProblem(
        "forbidden",
        "Forbidden",
        403,
        "The authenticated principal is not allowed to perform this operation.",
        "/v1/config/public",
      ),
    );
  });

  test("authenticates every v1 route and returns only allow-listed public config", async () => {
    const app = makeApp();
    apps.push(app);

    const anonymous = await app.inject({ method: "GET", url: "/v1/config/public" });
    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/config/public",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual(publicConfig);
  });

  test("does not serialize extra secret-shaped values supplied at runtime", async () => {
    const sentinel = "ROUTE_PRIVATE_SENTINEL_DO_NOT_SERIALIZE";
    const contaminatedConfig = {
      ...publicConfig,
      databaseUrl: `postgresql://${sentinel}@db.example.test/private`,
      cursorSigningKey: sentinel,
    } as PublicConfig;
    const app = makeApp(new FakeAuthenticator(), contaminatedConfig);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/config/public",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(publicConfig);
    expect(response.body).not.toContain(sentinel);
  });

  test("derives mutation authority from the principal and headers", async () => {
    const app = makeApp();
    apps.push(app);
    app.post(
      "/v1/testing/mutation",
      {
        config: {
          pihSecurity: { scopes: ["second-brain:write"], mutation: true },
        },
      },
      async (request) => request.mutationContext,
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/testing/mutation",
      headers: {
        authorization: "Bearer valid-token",
        "x-origin-channel": "test",
        "x-request-id": "77bc9c1a-b88e-4f77-9fcc-aa950f35cfd0",
        "idempotency-key": "test-key-123",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe(
      "77bc9c1a-b88e-4f77-9fcc-aa950f35cfd0",
    );
    expect(response.json()).toEqual({
      principal,
      source: "test",
      requestId: "77bc9c1a-b88e-4f77-9fcc-aa950f35cfd0",
      idempotencyKey: "test-key-123",
      routeTemplate: "/v1/testing/mutation",
      method: "POST",
    });
  });

  test("rejects a mutation source not granted to the principal", async () => {
    const app = makeApp();
    apps.push(app);
    app.post(
      "/v1/testing/mutation",
      {
        config: {
          pihSecurity: { scopes: ["second-brain:write"], mutation: true },
        },
      },
      async () => ({ unreachable: true }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/testing/mutation",
      headers: {
        authorization: "Bearer valid-token",
        "x-origin-channel": "automation",
        "idempotency-key": "test-key-123",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual(
      expectedProblem(
        "forbidden",
        "Forbidden",
        403,
        "The authenticated principal is not allowed to perform this operation.",
        "/v1/testing/mutation",
      ),
    );
  });

  test("maps malformed JSON from Fastify to a validation problem", async () => {
    const app = makeApp();
    apps.push(app);
    app.post(
      "/v1/testing/mutation",
      {
        config: {
          pihSecurity: { scopes: ["second-brain:write"], mutation: true },
        },
      },
      async () => ({ accepted: true }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/testing/mutation",
      headers: {
        authorization: "Bearer valid-token",
        "x-origin-channel": "test",
        "idempotency-key": "test-key-123",
        "content-type": "application/json",
      },
      payload: "{not-json",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      ...expectedProblem(
        "validation_failed",
        "Validation failed",
        422,
        "The request contains invalid values.",
        "/v1/testing/mutation",
      ),
      errors: [
        {
          path: "body",
          message: "The request body must contain valid JSON.",
          code: "invalid_json",
        },
      ],
    });
  });

  test("rejects a request body above the configured byte limit before the handler", async () => {
    const app = makeApp(new FakeAuthenticator(), publicConfig, 64);
    apps.push(app);
    app.post(
      "/v1/testing/mutation",
      {
        config: {
          pihSecurity: { scopes: ["second-brain:write"], mutation: true },
        },
      },
      async () => ({ accepted: true }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/testing/mutation",
      headers: {
        authorization: "Bearer valid-token",
        "x-origin-channel": "test",
        "idempotency-key": "test-key-123",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ value: "x".repeat(128) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual(
      expectedProblem(
        "payload_too_large",
        "Payload too large",
        413,
        "The request body exceeds the configured byte limit.",
        "/v1/testing/mutation",
      ),
    );
  });

  test("turns an invalid caller request ID into a validation problem with a safe generated ID", async () => {
    const app = makeApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "not-a-uuid" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual({
      ...expectedProblem(
        "validation_failed",
        "Validation failed",
        422,
        "The request contains invalid values.",
        "/health/live",
      ),
      errors: [
        {
          path: "headers.x-request-id",
          message: "X-Request-Id must be a UUID.",
          code: "invalid_format",
        },
      ],
    });
  });

  test("rejects a test-only authenticator in production", () => {
    expect(() =>
      buildApp({
        authenticator: new FakeAuthenticator(),
        cursorCodec: { encode: vi.fn(), decode: vi.fn() },
        unitOfWork: new InMemoryUnitOfWork(transactionPorts),
        queries,
        readinessCheck: async () => ({ status: "ready" }),
        clock: () => new Date(),
        requestIdFactory: () => requestId,
        publicConfig,
        runtime: "production",
        logger: false,
      }),
    ).toThrow("Test authenticators are forbidden in production.");
  });
});

describe("problem mapping", () => {
  test.each([
    [new AuthenticationRequiredError(), "authentication_required", 401, "Authentication required", "A bearer token is required."],
    [new InvalidTokenError(), "invalid_token", 401, "Invalid token", "The bearer token is invalid or expired."],
    [new ForbiddenError(), "forbidden", 403, "Forbidden", "The authenticated principal is not allowed to perform this operation."],
    [new ValidationError([{ path: "body.title", message: "Required", code: "too_small" }]), "validation_failed", 422, "Validation failed", "The request contains invalid values."],
    [new NotFoundError(), "not_found", 404, "Resource not found", "The requested resource does not exist."],
    [new PreconditionRequiredError(), "precondition_required", 428, "Precondition required", "A valid If-Match header is required."],
    [new VersionConflictError(), "version_conflict", 412, "Version conflict", "The resource has changed since it was read."],
    [new IdempotencyKeyRequiredError(), "idempotency_key_required", 400, "Idempotency key required", "A valid Idempotency-Key header is required."],
    [new IdempotencyKeyReusedError(), "idempotency_key_reused", 409, "Idempotency key reused", "The idempotency key was already used for a different request."],
    [new InvalidCursorError(), "invalid_cursor", 400, "Invalid cursor", "The cursor is invalid for this request."],
    [new CursorExpiredError(), "cursor_expired", 409, "Cursor expired", "The cursor is older than the retained event history."],
    [new ConflictError(), "conflict", 409, "Conflict", "The operation conflicts with the current resource state."],
    [new ApplicationError("internal_error"), "internal_error", 500, "Internal server error", "The server could not complete the request."],
    [new DependencyUnavailableError(), "dependency_unavailable", 503, "Dependency unavailable", "A required dependency is unavailable."],
  ] as const)(
    "maps %s to a stable RFC 9457 problem",
    (error, code, status, title, detail) => {
      expect(toApiProblem(error, requestId, "/v1/example")).toEqual({
        type: `https://pih.example/problems/${code.replaceAll("_", "-")}`,
        title,
        status,
        detail,
        instance: "/v1/example",
        code,
        requestId,
        ...(code === "validation_failed"
          ? {
              errors: [
                { path: "body.title", message: "Required", code: "too_small" },
              ],
            }
          : {}),
      });
    },
  );
});
