import { describe, expect, it, vi } from "vitest";
import { preferencesFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

import type { RequestContext } from "../context";
import type { ConnectorsHttp } from "./connectors-http";
import { HttpPreferencesGateway } from "./http-preferences-gateway";

const context: RequestContext = {
  authorization: "Bearer source-token", concurrencyKey: "fixture:actor", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};

describe("HttpPreferencesGateway", () => {
  it("reads user preferences without mutating them", async () => {
    const call = vi.fn(async () => preferencesFixture());
    const gateway = new HttpPreferencesGateway({ json: call } as unknown as Pick<ConnectorsHttp, "json">);
    await expect(gateway.get(context)).resolves.toEqual(preferencesFixture());
    expect(call).toHaveBeenCalledWith(context, expect.objectContaining({ path: "/v1/preferences", method: "GET", scope: "preferences:read" }));
  });

  it("forwards expectedVersion unchanged with the write-only scope", async () => {
    const call = vi.fn(async () => preferencesFixture({ version: 6, timeZone: "America/Argentina/Buenos_Aires" }));
    const gateway = new HttpPreferencesGateway({ json: call } as unknown as Pick<ConnectorsHttp, "json">);
    const body = { timeZone: "America/Argentina/Buenos_Aires", expectedVersion: 5 };
    await expect(gateway.patch(context, body)).resolves.toEqual(preferencesFixture({ version: 6, timeZone: body.timeZone }));
    expect(call).toHaveBeenCalledWith(context, expect.objectContaining({ path: "/v1/preferences", method: "PATCH", scope: "preferences:write", body }));
  });
});
