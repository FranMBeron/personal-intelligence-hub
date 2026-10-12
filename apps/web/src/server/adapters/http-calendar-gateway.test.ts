import { describe, expect, it, vi } from "vitest";
import { agendaFixture, calendarStatusFixture, proposalFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

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

  it("uses the configure scope for calendar discovery and selection reads", async () => {
    const json = vi.fn(async () => ({ version: 1, items: [] }));
    const gateway = new HttpCalendarGateway({ json } as unknown as Pick<ConnectorsHttp, "json">);
    await gateway.calendars(context);
    await gateway.selection(context);
    expect(json).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
      path: "/v1/calendar/calendars", method: "GET", scope: "calendar:configure",
    }));
    expect(json).toHaveBeenNthCalledWith(2, context, expect.objectContaining({
      path: "/v1/calendar/selection", method: "GET", scope: "calendar:configure",
    }));
  });

  it("forwards a mandatory proposal idempotency key consistently for retries", async () => {
    const json = vi.fn(async () => proposalFixture());
    const gateway = new HttpCalendarGateway({ json } as unknown as Pick<ConnectorsHttp, "json">);
    const body = {
      operation: "create" as const,
      calendarRef: "fictional-calendar",
      draft: {
        title: "Fictional meeting",
        time: { kind: "all_day" as const, startDate: "2026-10-12", endDateExclusive: "2026-10-13" },
        attendees: [],
      },
      guestNotification: "none" as const,
    };
    await gateway.propose(context, "calendar-proposal-key-01", body);
    await gateway.propose(context, "calendar-proposal-key-01", body);
    expect(json).toHaveBeenNthCalledWith(1, context, expect.objectContaining({
      path: "/v1/calendar/change-proposals", method: "POST", scope: "calendar:propose",
      idempotencyKey: "calendar-proposal-key-01", body,
    }));
    expect(json).toHaveBeenNthCalledWith(2, context, expect.objectContaining({
      idempotencyKey: "calendar-proposal-key-01", body,
    }));
  });

  it("rejects an empty proposal idempotency key before issuing a request", () => {
    const json = vi.fn(async () => proposalFixture());
    const gateway = new HttpCalendarGateway({ json } as unknown as Pick<ConnectorsHttp, "json">);
    let failure: unknown;
    try {
      gateway.propose(context, "  ", {
        operation: "cancel", eventRef: "fictional-event", recurrenceScope: "single", guestNotification: "none",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ problem: { status: 400, code: "validation_failed" } });
    expect(json).not.toHaveBeenCalled();
  });

  it("validates normalized calendar source status", async () => {
    const http = { json: vi.fn(async () => calendarStatusFixture()) } as unknown as Pick<ConnectorsHttp, "json">;
    await expect(new HttpCalendarGateway(http).status(context)).resolves.toEqual(calendarStatusFixture());
  });
});
