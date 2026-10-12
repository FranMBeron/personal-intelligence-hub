import { describe, expect, it, vi } from "vitest";

import { GoogleCalendarHttpAdapter } from "./google-calendar-http.js";

const calendarList = (items: unknown[], nextPageToken?: string) => ({
  items,
  ...(nextPageToken === undefined ? {} : { nextPageToken }),
});
const calendar = (overrides: Record<string, unknown> = {}) => ({
  id: "fictional-calendar-id@example.test",
  summary: "Fictional calendar",
  primary: false,
  accessRole: "writer",
  ...overrides,
});
const event = (overrides: Record<string, unknown> = {}) => ({
  id: "event-id-01",
  etag: '"etag-1"',
  status: "confirmed",
  start: { dateTime: "2026-10-12T14:00:00Z" },
  end: { dateTime: "2026-10-12T14:30:00Z" },
  updated: "2026-10-12T12:00:00Z",
  ...overrides,
});
const response = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const makeAdapter = (fetcher: typeof fetch) => new GoogleCalendarHttpAdapter({ fetch: fetcher, timeoutMs: 100 });

describe("Google Calendar HTTP adapter", () => {
  it("paginates calendar lists and maps supported access roles", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(calendarList([calendar({ id: "cal-one", accessRole: "owner" })], "page-2")))
      .mockResolvedValueOnce(response(calendarList([calendar({ id: "cal-two", accessRole: "reader" })])));
    const result = await makeAdapter(fetcher).listCalendars("fictional-access-token");
    expect(result).toEqual([
      { id: "cal-one", summary: "Fictional calendar", primary: false, accessRole: "owner" },
      { id: "cal-two", summary: "Fictional calendar", primary: false, accessRole: "reader" },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("pageToken")).toBe("page-2");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer fictional-access-token");
  });

  it("rejects repeated page cursors and stops at the pagination ceiling", async () => {
    const repeated = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(calendarList([calendar()], "repeat")))
      .mockResolvedValueOnce(response(calendarList([calendar()], "repeat")));
    await expect(makeAdapter(repeated).listCalendars("fictional-token")).rejects.toThrow("google_calendar_response_invalid");
    expect(repeated).toHaveBeenCalledTimes(2);

    let boundedPage = 0;
    const bounded = vi.fn<typeof fetch>().mockImplementation(async () => {
      boundedPage += 1;
      return response(calendarList([calendar()], `next-${boundedPage}`));
    });
    await expect(makeAdapter(bounded).listCalendars("fictional-token")).rejects.toThrow("google_calendar_response_invalid");
    expect(bounded).toHaveBeenCalledTimes(20);
  });

  it("rejects oversized response bodies before parsing provider data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      status: 200, headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
    }));
    await expect(makeAdapter(fetcher).listCalendars("fictional-token")).rejects.toThrow("google_calendar_response_too_large");
  });

  it("encodes event paths and query values and uses If-Match/sendUpdates", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [event()], nextPageToken: "next token" }))
      .mockResolvedValueOnce(response(event()))
      .mockResolvedValueOnce(response(undefined, 204));
    const port = makeAdapter(fetcher);
    const request = { calendarId: "calendar id@example.test", timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z", timeZone: "America/Argentina/Buenos_Aires" };
    await port.listEvents("fictional-token", request);
    const listUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(listUrl.pathname).toContain("calendar%20id%40example.test");
    expect(listUrl.searchParams.get("timeMin")).toBe(request.timeMin);
    expect(listUrl.searchParams.get("timeMax")).toBe(request.timeMax);
    expect(listUrl.searchParams.get("timeZone")).toBe(request.timeZone);
    await port.updateEvent("fictional-token", { calendarId: request.calendarId, eventId: "event/one", expectedEtag: '"etag-1"', event: { summary: "Updated", start: { dateTime: request.timeMin }, end: { dateTime: request.timeMax } }, sendUpdates: "externalOnly" });
    const updateInit = fetcher.mock.calls[1]?.[1];
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("event%2Fone");
    expect(new Headers(updateInit?.headers).get("if-match")).toBe('"etag-1"');
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("sendUpdates")).toBe("externalOnly");
    await port.deleteEvent("fictional-token", { calendarId: request.calendarId, eventId: "event-1", expectedEtag: '"etag-2"', sendUpdates: "none" });
    expect(new URL(String(fetcher.mock.calls[2]?.[0])).searchParams.get("sendUpdates")).toBe("none");
  });

  it("creates deterministic provider events with only the writable projection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(event()));
    const port = makeAdapter(fetcher);
    await port.createEvent("fictional-token", {
      calendarId: "cal-one", providerEventId: "event-id-01",
      event: { summary: "Fictional plan", description: "Details", start: { dateTime: "2026-10-12T14:00:00Z" }, end: { dateTime: "2026-10-12T15:00:00Z" } },
      sendUpdates: "all",
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/calendars/cal-one/events?sendUpdates=all");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      id: "event-id-01", summary: "Fictional plan", description: "Details",
      start: { dateTime: "2026-10-12T14:00:00Z" }, end: { dateTime: "2026-10-12T15:00:00Z" },
    });
  });

  it("models invitation response and removal semantics", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(event()))
      .mockResolvedValueOnce(response(event()));
    const port = makeAdapter(fetcher);
    await port.respondToInvitation("fictional-token", { calendarId: "cal-one", eventId: "event-one", expectedEtag: '"e"', response: "declined", sendUpdates: "all" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ attendeesOmitted: true, attendees: [{ responseStatus: "declined" }] });
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("sendUpdates")).toBe("all");
    await port.respondToInvitation("fictional-token", { calendarId: "cal-one", eventId: "event-one", expectedEtag: '"e"', response: "removed", sendUpdates: "none" });
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("/events/event-one?sendUpdates=none");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("keeps its timeout active while consuming a stalled response body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"items\":["));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const port = new GoogleCalendarHttpAdapter({ fetch: fetcher, timeoutMs: 15 });
    await expect(port.listCalendars("fictional-token")).rejects.toThrow("google_calendar_timeout");
  });

  it.each([
    [401, "google_calendar_reauthorization_required"],
    [403, "google_calendar_permission_denied"],
    [410, "google_calendar_conflict"],
    [412, "google_calendar_conflict"],
    [429, "google_calendar_temporarily_unavailable"],
    [503, "google_calendar_temporarily_unavailable"],
  ] as const)("normalizes status %s without exposing provider text", async (status, code) => {
    const port = makeAdapter(vi.fn<typeof fetch>().mockResolvedValue(response({ error: "fictional-sensitive-provider-detail" }, status)));
    await expect(port.listCalendars("fictional-access-token")).rejects.toThrow(code);
  });

  it("rejects nested writable fields and path traversal before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(event()));
    const port = makeAdapter(fetcher);
    await expect(port.createEvent("fictional-token", {
      calendarId: "cal-one", providerEventId: "event-1",
      event: { summary: "Fictional", start: { dateTime: "2026-10-12T14:00:00Z", attendees: [] } as never, end: { dateTime: "2026-10-12T15:00:00Z" } },
      sendUpdates: "none",
    })).rejects.toThrow("google_calendar_request_invalid");
    await expect(port.getEvent("fictional-token", "../../events", "event-1")).rejects.toThrow("google_calendar_request_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects redirects and caller-supplied absolute calendar URLs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.example.test" } }));
    const port = makeAdapter(fetcher);
    await expect(port.listCalendars("fictional-token")).rejects.toThrow("google_calendar_request_failed");
    expect(String(fetcher.mock.calls[0]?.[0]).startsWith("https://www.googleapis.com/")).toBe(true);
    await expect(port.getEvent("fictional-token", "https://attacker.example.test", "event-1")).rejects.toThrow("google_calendar_request_invalid");
  });
});

