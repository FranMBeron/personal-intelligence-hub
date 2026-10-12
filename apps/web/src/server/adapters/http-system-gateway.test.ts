import { describe, expect, it, vi } from "vitest";
import { sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

import type { RequestContext } from "../context";
import type { ConnectorsHttp } from "./connectors-http";
import { HttpSystemGateway } from "./http-system-gateway";

const context: RequestContext = {
  authorization: "Bearer source-token", concurrencyKey: "fixture:actor", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};

describe("HttpSystemGateway", () => {
  it("uses the system:read route and validates status DTOs", async () => {
    const call = vi.fn(async () => ({ sources: [sourceStatusFixture()] }));
    const gateway = new HttpSystemGateway({ json: call } as unknown as Pick<ConnectorsHttp, "json">);
    await expect(gateway.status(context)).resolves.toEqual({ sources: [sourceStatusFixture()] });
    expect(call).toHaveBeenCalledWith(context, expect.objectContaining({ path: "/v1/system/status", method: "GET", scope: "system:read" }));
  });
});
