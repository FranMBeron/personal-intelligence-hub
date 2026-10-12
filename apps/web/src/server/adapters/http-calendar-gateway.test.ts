import { describe, expect, it, vi } from "vitest";
import { agendaFixture, calendarStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

import type { RequestContext } from "../context";
import type { ConnectorsHttp } from "./connectors-http";
import { HttpCalendarGateway } from "./http-calendar-gateway";

const context: RequestContext = {
  authorization: "Bearer source-token",
  concurrencyKey: "fixture:actor",
  requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};

describe("HttpCalendarGateway", () => {
  it("builds only the validated agenda query fields", async () => {
    const calls: unknown[] = [];
    const http = { json: vi.fn(async (_context: RequestContext, request: unknown) => {
      calls.push(request);
      return agendaFixture();
    }) } as unknown as Pick<ConnectorsHttp, "json">;
    const gateway = new HttpCalendarGateway(http);
    const query = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", timeZone: "UTC" };
    await expect(gateway.agenda(context, query)).resolves.toEqual(agendaFixture());
    expect(calls[0]).toMatchObject({ path: "/v1/calendar/agenda?from=2026-10-12T00%3A00%3A00.000Z&to=2026-10-13T00%3A00%3A00.000Z&timeZone=UTC", method: "GET", scope: "calendar:read" });
  });

  it("encodes opaque event references as one path segment", async () => {
    const calls: unknown[] = [];
    const http = { json: vi.fn(async (_context: RequestContext, request: unknown) => {
      calls.push(request);
      return agendaFixture();
    }) } as unknown as Pick<ConnectorsHttp, "json">;
    const gateway = new HttpCalendarGateway(http);
    await gateway.event(context, "event/a?b");
    expect(calls[0]).toMatchObject({ path: "/v1/calendar/events/event%2Fa%3Fb", method: "GET", scope: "calendar:read" });
  });

  it("validates normalized calendar source status", async () => {
    const http = { json: vi.fn(async () => calendarStatusFixture()) } as unknown as Pick<ConnectorsHttp, "json">;
    await expect(new HttpCalendarGateway(http).status(context)).resolves.toEqual(calendarStatusFixture());
  });
});
