import { describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../context";
import type { ConnectorsHttp } from "./connectors-http";
import { HttpDeviceConnectionsGateway } from "./http-device-connections-gateway";

const context: RequestContext = {
  authorization: "Bearer source-token", concurrencyKey: "fixture:actor", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};

const status = {
  connectionId: "example-band", label: "Example band", state: "connected", reasonCode: null,
  checkedAt: "2026-10-26T12:00:00.000Z",
} as const;

const gatewayWith = (call: ReturnType<typeof vi.fn>) =>
  new HttpDeviceConnectionsGateway({ json: call } as unknown as Pick<ConnectorsHttp, "json">);

describe("HttpDeviceConnectionsGateway", () => {
  it("reads status with the read scope", async () => {
    const call = vi.fn(async () => status);
    await expect(gatewayWith(call).status(context, "example-band")).resolves.toEqual(status);
    expect(call).toHaveBeenCalledWith(context, expect.objectContaining({
      path: "/v1/device-connections/example-band", method: "GET", scope: "devices:read",
    }));
  });

  it("triggers a reconnect with the write scope and no body", async () => {
    const call = vi.fn(async () => status);
    await gatewayWith(call).reconnect(context, "example-band");
    const [, request] = call.mock.calls[0] as unknown as [RequestContext, Record<string, unknown>];
    expect(request).toMatchObject({ path: "/v1/device-connections/example-band/reconnect", method: "POST", scope: "devices:write" });
    expect(request.body).toBeUndefined();
  });

  it.each(["../system", "Example", "a/b", ""])("refuses the connection id %j before calling connectors", async (id) => {
    const call = vi.fn(async () => status);
    await expect(gatewayWith(call).status(context, id)).rejects.toThrow();
    await expect(gatewayWith(call).reconnect(context, id)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});
