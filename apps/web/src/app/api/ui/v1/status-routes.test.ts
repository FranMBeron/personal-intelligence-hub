// @vitest-environment node

import { sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it, vi } from "vitest";

import type { RequestIdentityAdapter } from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { IdentityRateLimiter } from "../../../../server/identity-rate-limit";
import { GatewayError } from "../../../../server/problems";
import type { PreferencesGateway } from "../../../../server/ports/preferences-gateway";
import type { SystemGateway } from "../../../../server/ports/system-gateway";
import {
  createGetPreferencesHandler,
  createPatchPreferencesHandler,
  createSystemStatusHandler,
} from "./_lib/status-handlers";
import type { RequestPolicy } from "./_lib/request-guards";

const principal = { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:fictional@example.test", actorType: "human" as const };
const identity: RequestIdentityAdapter = {
  async resolve(headers) {
    const authorization = headers.get("authorization");
    if (authorization === null || !/^Bearer\s+\S+$/iu.test(authorization)) {
      return { ok: false, status: 401, title: "Authentication required", detail: "A bearer token is required." };
    }
    return { ok: true, authorization, concurrencyKey: "oidc:fictional-human", principal };
  },
};
const policy: RequestPolicy = {
  publicOrigin: "https://pih.example",
  identity,
  maxUploadBodyBytes: 1_048_576,
  agentConcurrency: new IdentityConcurrencyLimiter(2),
  agentRateLimit: new IdentityRateLimiter({ maximum: 20 }),
};
const headers = (values: HeadersInit = {}) => new Headers({
  authorization: "Bearer delegated-test-token",
  origin: "https://pih.example",
  "content-type": "application/json",
  ...values,
});
const request = (method: string, body?: unknown, values: HeadersInit = {}) =>
  new Request("https://pih.example/api/ui/v1/preferences", {
    method, headers: headers(values), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const preferences = { timeZone: "America/Argentina/Buenos_Aires", version: 4 };
const conflict = () => new GatewayError({
  type: "about:blank", title: "Version conflict", status: 409, detail: "Reload before retrying.",
  instance: "/api/ui/v1/preferences", code: "version_conflict", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
});

describe("system and preference route handlers", () => {
  it("returns authenticated, no-store system status and 503 when unavailable", async () => {
    const status = vi.fn(async () => ({ sources: [sourceStatusFixture()] }));
    const handler = createSystemStatusHandler({ status } as unknown as SystemGateway, policy);
    const denied = await handler(new Request("https://pih.example/api/ui/v1/system/status"));
    expect(denied.status).toBe(401);
    const response = await handler(new Request("https://pih.example/api/ui/v1/system/status", { headers: headers() }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ principal }), expect.any(AbortSignal));
    const unavailable = await createSystemStatusHandler(null, policy)(new Request("https://pih.example/api/ui/v1/system/status", { headers: headers() }));
    expect(unavailable.status).toBe(503);
  });

  it("GET preferences is read-only and does not require Origin", async () => {
    const get = vi.fn(async () => preferences);
    const patch = vi.fn();
    const handler = createGetPreferencesHandler({ get, patch } as unknown as PreferencesGateway, policy);
    const response = await handler(new Request("https://pih.example/api/ui/v1/preferences", {
      headers: { authorization: "Bearer delegated-test-token" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(get).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://foreign.example"])("does not patch preferences without the application origin (%s)", async (origin) => {
    const patch = vi.fn(async () => preferences);
    const handler = createPatchPreferencesHandler({ get: vi.fn(), patch } as unknown as PreferencesGateway, policy);
    const values = origin === undefined ? { origin: "" } : { origin };
    const response = await handler(request("PATCH", { timeZone: "UTC", expectedVersion: 4 }, values));
    expect(response.status).toBe(403);
    expect(patch).not.toHaveBeenCalled();
  });

  it("validates preference updates, forwards expectedVersion, and preserves conflicts", async () => {
    const patch = vi.fn(async () => { throw conflict(); });
    const handler = createPatchPreferencesHandler({ get: vi.fn(), patch } as unknown as PreferencesGateway, policy);
    const malformed = await handler(request("PATCH", { timeZone: "not a timezone", expectedVersion: 4 }));
    expect(malformed.status).toBe(422);
    expect(patch).not.toHaveBeenCalled();
    const response = await handler(request("PATCH", { timeZone: "UTC", expectedVersion: 17 }));
    expect(response.status).toBe(409);
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ principal }), { timeZone: "UTC", expectedVersion: 17 }, expect.any(AbortSignal));
    await expect(response.json()).resolves.toMatchObject({ status: 409, code: "version_conflict" });
  });

  it("returns dependency unavailable for null preference gateways", async () => {
    const response = await createGetPreferencesHandler(null, policy)(
      new Request("https://pih.example/api/ui/v1/preferences", { headers: headers() }),
    );
    expect(response.status).toBe(503);
  });
});
