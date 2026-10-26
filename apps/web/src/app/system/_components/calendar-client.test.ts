import { describe, expect, it, vi } from "vitest";

import {
  calendarSelectionFixture,
  calendarStatusFixture,
  proposalFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { BffRequestError } from "../../_lib/bff-request";
import { CalendarClient } from "./calendar-client";

type Call = { path: string; method: string; body: unknown; headers: Record<string, string>; signal: AbortSignal | undefined };

const recorder = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, client: new CalendarClient(fetcher) };
};

describe("CalendarClient", () => {
  it("reads status, persisted selection and discovery through the BFF only", async () => {
    const { calls, client } = recorder((call) => call.path.endsWith("/status")
      ? Response.json(calendarStatusFixture())
      : Response.json(calendarSelectionFixture({ version: 2 })));
    const controller = new AbortController();
    await client.status(controller.signal);
    await client.selection();
    const discovered = await client.calendars();
    expect(discovered.items).toEqual([]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/ui/v1/calendar/status",
      "GET /api/ui/v1/calendar/selection",
      "GET /api/ui/v1/calendar/calendars",
    ]);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("starts authorization with an explicit POST and validates the HTTPS link", async () => {
    const { calls, client } = recorder(() => Response.json({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional", expiresAt: "2026-10-12T12:10:00.000Z" }));
    const start = await client.startAuthorization();
    expect(start.authorizationUrl.startsWith("https://")).toBe(true);
    expect(calls[0]).toMatchObject({ path: "/api/ui/v1/calendar/oauth/authorizations", method: "POST" });
    const insecure = recorder(() => Response.json({ authorizationUrl: "http://example.test/auth", expiresAt: "2026-10-12T12:10:00.000Z" }));
    await expect(insecure.client.startAuthorization()).rejects.toThrow();
  });

  it("sends the versioned selection body and surfaces a 409 without retrying", async () => {
    const { calls, client } = recorder(() => Response.json({ type: "about:blank", title: "Conflict", status: 409 }, { status: 409 }));
    const failure = await client.updateSelection({ expectedVersion: 4, calendars: [{ calendarRef: "cal-a", readEnabled: true, writeEnabled: false }] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BffRequestError);
    expect((failure as BffRequestError).status).toBe(409);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/ui/v1/calendar/selection", method: "PUT", body: { expectedVersion: 4, calendars: [{ calendarRef: "cal-a", readEnabled: true, writeEnabled: false }] } });
  });

  it("encodes opaque proposal IDs and sends only the expected version on confirmation", async () => {
    const { calls, client } = recorder(() => Response.json(proposalFixture({ status: "executing", version: 1 })));
    await client.confirm("a/b c", 0);
    await client.reject("a/b c", 0);
    await client.proposal("a/b c");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/ui/v1/calendar/change-proposals/a%2Fb%20c/confirmation",
      "POST /api/ui/v1/calendar/change-proposals/a%2Fb%20c/rejection",
      "GET /api/ui/v1/calendar/change-proposals/a%2Fb%20c",
    ]);
    expect(calls[0]?.body).toEqual({ expectedVersion: 0 });
  });

  it("creates proposals with a caller-held idempotency key", async () => {
    const { calls, client } = recorder(() => Response.json(proposalFixture(), { status: 201 }));
    const body = { operation: "respond_invitation", eventRef: "event-a", recurrenceScope: "single", response: "accepted", guestNotification: "none" } as const;
    await client.propose(body, "intent-key-0001");
    await client.propose(body, "intent-key-0001");
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual(["intent-key-0001", "intent-key-0001"]);
    expect(calls[0]).toMatchObject({ path: "/api/ui/v1/calendar/change-proposals", method: "POST", body });
  });

  it("disconnects and bootstraps with explicit mutations", async () => {
    const { calls, client } = recorder((call) => call.method === "DELETE"
      ? Response.json(sourceStatusFixture({ id: "calendar", state: "not_configured" }))
      : Response.json(calendarStatusFixture({ state: "available" })));
    expect((await client.disconnect()).state).toBe("not_configured");
    expect((await client.bootstrap()).state).toBe("available");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/ui/v1/calendar/connection",
      "POST /api/ui/v1/calendar/bootstrap",
    ]);
  });
});
