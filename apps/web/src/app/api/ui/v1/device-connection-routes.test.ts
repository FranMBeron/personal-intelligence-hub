// @vitest-environment node

import type { DeviceConnectionStatus } from "@personal-intelligence-hub/contracts";
import { describe, expect, it, vi } from "vitest";

import type { RequestIdentityAdapter, VerifiedPrincipal } from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { GatewayError } from "../../../../server/problems";
import type { DeviceConnectionsGateway } from "../../../../server/ports/device-connections-gateway";
import {
  createDeviceConnectionReconnectHandler,
  createDeviceConnectionStatusHandler,
} from "./_lib/device-connection-handlers";
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
    if (authorization === null) {
      return { ok: false, status: 401, title: "Authentication required", detail: "A bearer token is required." };
    }
    return { ok: true, authorization, concurrencyKey: "oidc:fictional-human", ...(principal === undefined ? {} : { principal }) };
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

const status = (overrides: Partial<DeviceConnectionStatus> = {}): DeviceConnectionStatus => ({
  connectionId: "example-band", label: "Example band", state: "connected", reasonCode: null,
  checkedAt: "2026-10-26T12:00:00.000Z", ...overrides,
});

const gatewayStub = (overrides: Partial<DeviceConnectionsGateway> = {}): DeviceConnectionsGateway => ({
  status: vi.fn(async () => status()),
  reconnect: vi.fn(async () => status()),
  ...overrides,
});

const request = (path: string, method = "GET", headers: Record<string, string | null> = {}, body?: string): Request => {
  const values = new Headers({ authorization: "Bearer delegated-test-token", origin: ORIGIN });
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) values.delete(key);
    else values.set(key, value);
  }
  return new Request(`${ORIGIN}/api/ui/v1/device-connections${path}`, {
    method, headers: values, ...(body === undefined ? {} : { body }),
  });
};
const params = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

describe("device connection BFF routes", () => {
  it("returns the validated status for the verified human without caching", async () => {
    const gateway = gatewayStub();
    const response = await createDeviceConnectionStatusHandler(gateway, policy)(request("/example-band"), params("example-band"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status());
    expect(gateway.status).toHaveBeenCalledWith(expect.objectContaining({ principal: human }), "example-band", expect.anything());
  });

  it("relays a non-connected reconnect result as-is", async () => {
    const gateway = gatewayStub({
      reconnect: vi.fn(async () => status({ state: "unavailable", reasonCode: "device_unreachable", action: "wake_device" })),
    });
    const response = await createDeviceConnectionReconnectHandler(gateway, policy)(
      request("/example-band/reconnect", "POST"), params("example-band"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "unavailable", action: "wake_device" });
  });

  it("rejects a reconnect without the application origin", async () => {
    const gateway = gatewayStub();
    for (const origin of [null, "https://evil.example.test"]) {
      const response = await createDeviceConnectionReconnectHandler(gateway, policy)(
        request("/example-band/reconnect", "POST", { origin }), params("example-band"),
      );
      expect(response.status).toBe(403);
    }
    expect(gateway.reconnect).not.toHaveBeenCalled();
  });

  it("requires a verified human identity", async () => {
    const gateway = gatewayStub();
    const unauthenticated = await createDeviceConnectionStatusHandler(gateway, policy)(
      request("/example-band", "GET", { authorization: null }), params("example-band"),
    );
    const anonymous = await createDeviceConnectionReconnectHandler(gateway, policyFor(undefined))(
      request("/example-band/reconnect", "POST"), params("example-band"),
    );

    expect(unauthenticated.status).toBe(401);
    expect(anonymous.status).toBe(401);
    expect(gateway.status).not.toHaveBeenCalled();
    expect(gateway.reconnect).not.toHaveBeenCalled();
  });

  it("accepts no free-form input: query, body or malformed id", async () => {
    const gateway = gatewayStub();
    const withQuery = await createDeviceConnectionStatusHandler(gateway, policy)(
      request("/example-band?socket=/tmp/x.sock"), params("example-band"),
    );
    const withBody = await createDeviceConnectionReconnectHandler(gateway, policy)(
      request("/example-band/reconnect", "POST", { "content-type": "application/json" }, JSON.stringify({ command: "restart" })),
      params("example-band"),
    );
    const badId = await createDeviceConnectionStatusHandler(gateway, policy)(request("/x"), params("../system"));

    expect(withQuery.status).toBe(422);
    expect(withBody.status).toBe(422);
    expect(badId.status).toBe(422);
    expect(gateway.status).not.toHaveBeenCalled();
    expect(gateway.reconnect).not.toHaveBeenCalled();
  });

  it("passes through sanitized connector problems", async () => {
    const gateway = gatewayStub({
      reconnect: vi.fn(async () => {
        throw new GatewayError({
          type: "about:blank", title: "Forbidden", status: 403, detail: "The request is not allowed.",
          instance: "/api/ui/v1", code: "forbidden", requestId: REQUEST_ID,
        });
      }),
    });
    const response = await createDeviceConnectionReconnectHandler(gateway, policy)(
      request("/example-band/reconnect", "POST"), params("example-band"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  it("fails closed when the connector returns an invalid status", async () => {
    const gateway = gatewayStub({ status: vi.fn(async () => ({ ...status(), state: "active" }) as never) });
    const response = await createDeviceConnectionStatusHandler(gateway, policy)(request("/example-band"), params("example-band"));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("active");
  });

  it("reports an unconfigured deployment as unavailable", async () => {
    const response = await createDeviceConnectionStatusHandler(null, policy)(request("/example-band"), params("example-band"));
    expect(response.status).toBe(503);
  });
});
