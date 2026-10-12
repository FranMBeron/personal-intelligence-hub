import type { Principal } from "@personal-intelligence-hub/contracts";
import fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InvalidTokenError } from "../application/errors.js";
import { installErrorHandler } from "../errors.js";
import { installAuthentication } from "./auth.js";
import { installRequestContext } from "./request-context.js";

const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const principal: Principal = {
  subject: "test-subject",
  actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
  actorType: "human",
  scopes: ["second-brain:read", "second-brain:write"],
  allowedSources: ["test"],
};

const apps: ReturnType<typeof fastify>[] = [];

const makeApp = () => {
  const app = fastify({ logger: false });
  const authenticate = vi.fn(async (token: string) => {
    if (token !== "valid-token") throw new InvalidTokenError();
    return principal;
  });
  installRequestContext(app, () => requestId);
  installAuthentication(app, { kind: "test", authenticate });
  installErrorHandler(app);
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ready" }));
  app.get("/v1/testing/read", async (request) => request.principal);
  app.post("/v1/testing/mutation", async (request) => request.mutationContext);
  apps.push(app);
  return { app, authenticate };
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe("API authentication rate limit", () => {
  test.each(["missing", "invalid"] as const)(
    "bounds %s credentials before further authentication",
    async (credential) => {
      const { app, authenticate } = makeApp();
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const response = await app.inject({
          method: "GET",
          url: attempt % 2 === 0 ? "/health/ready" : "/v1/testing/read?probe=1",
          remoteAddress: "192.0.2.10",
          headers: {
            ...(credential === "invalid"
              ? { authorization: `Bearer invalid-token-${attempt}` }
              : {}),
            "x-forwarded-for": `198.51.100.${attempt % 255}`,
            "x-pih-actor-id": `untrusted-identity-${attempt}`,
          },
        });
        expect(response.statusCode).toBe(401);
      }
      const callsBeforeLimit = authenticate.mock.calls.length;
      const rejected = await app.inject({
        method: "GET",
        url: "/v1/testing/read",
        remoteAddress: "192.0.2.10",
        headers: { authorization: "Bearer valid-token" },
      });

      expect(rejected.statusCode).toBe(429);
      expect(rejected.headers["content-type"]).toMatch(/^application\/problem\+json/u);
      expect(rejected.headers["x-request-id"]).toBe(requestId);
      expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
      expect(rejected.json()).toMatchObject({
        code: "too_many_requests",
        status: 429,
        requestId,
        instance: "/v1/testing/read",
      });
      expect(authenticate.mock.calls.length).toBe(callsBeforeLimit);
    },
  );

  test("shares the protected request budget across routes and preserves public liveness, client isolation, and window recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00.000Z"));
    const { app, authenticate } = makeApp();
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: attempt % 2 === 0 ? "/health/ready" : "/v1/testing/read",
        remoteAddress: "192.0.2.10",
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode).toBe(200);
    }

    const mutation = {
      method: "POST" as const,
      url: "/v1/testing/mutation",
      remoteAddress: "192.0.2.10",
      headers: {
        authorization: "Bearer valid-token",
        "x-origin-channel": "test",
        "idempotency-key": "rate-limit-test-key",
        "x-forwarded-for": "198.51.100.99",
      },
    };
    const rejected = await app.inject(mutation);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["retry-after"]).toBe("60");
    expect(authenticate).toHaveBeenCalledTimes(1_000);

    const live = await app.inject({
      method: "GET", url: "/health/live", remoteAddress: "192.0.2.10",
    });
    expect(live.statusCode).toBe(200);

    const otherClient = await app.inject({ ...mutation, remoteAddress: "192.0.2.11" });
    expect(otherClient.statusCode).toBe(200);
    expect(otherClient.json()).toMatchObject({
      principal, source: "test", idempotencyKey: "rate-limit-test-key",
    });

    vi.setSystemTime(new Date("2026-10-11T12:01:00.001Z"));
    const recovered = await app.inject(mutation);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      principal, source: "test", idempotencyKey: "rate-limit-test-key",
    });
  });
});
