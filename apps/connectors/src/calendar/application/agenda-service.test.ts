import { afterEach, describe, expect, it } from "vitest";

import { CalendarAgendaSchema, type DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import {
  FakeGoogleCalendar,
  TestClock,
  actorId,
  closeTestDatabases,
  fakeTokens,
  googleEvent,
  humanPrincipal,
  centralPrincipal,
  keyring,
  openTestDatabase,
  otherActorId,
  repository,
  seedCalendars,
  seedConnection,
} from "../../../test/calendar/fixtures.js";
import { CalendarAgendaServiceImpl } from "./agenda-service.js";
import { CalendarEventReader } from "./calendar-event-reader.js";

const query = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z", timeZone: "America/Argentina/Buenos_Aires" };

const setup = async () => {
  const { db } = await openTestDatabase();
  await seedConnection(db);
  const google = new FakeGoogleCalendar();
  const clock = new TestClock();
  const tokens = fakeTokens(db);
  const reader = new CalendarEventReader({ database: db, repository, tokens, google, keyring, clock: clock.now });
  return { db, google, clock, tokens, service: new CalendarAgendaServiceImpl({ reader, clock: clock.now }) };
};

afterEach(closeTestDatabases);

describe("Calendar agenda service", () => {
  it("reads only read-enabled calendars and returns a chronological, schema-valid agenda", async () => {
    const { db, google, service } = await setup();
    const refs = await seedCalendars(db, [
      { providerId: "primary@example.test", displayName: "Primary", isPrimary: true, readEnabled: true, writeEnabled: true },
      { providerId: "second@example.test", displayName: "Second", readEnabled: true },
      { providerId: "write-only@example.test", displayName: "Write only", readEnabled: false, writeEnabled: true, role: "writer" },
    ]);
    google.pages.set("primary@example.test", [[
      googleEvent({ id: "late", summary: "Late", start: { dateTime: "2026-10-12T18:00:00Z" }, end: { dateTime: "2026-10-12T19:00:00Z" } }),
      googleEvent({ id: "gone", status: "cancelled" }),
    ]]);
    google.pages.set("second@example.test", [[
      googleEvent({ id: "early", summary: "Early", status: "tentative", start: { dateTime: "2026-10-12T09:00:00Z" }, end: { dateTime: "2026-10-12T10:00:00Z" } }),
      googleEvent({ id: "all-day", summary: "All day", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }),
    ]]);
    google.pages.set("write-only@example.test", [[googleEvent({ id: "hidden", summary: "Hidden" })]]);

    const agenda = await service.read(humanPrincipal(), query);

    expect(CalendarAgendaSchema.parse(agenda)).toEqual(agenda);
    expect(agenda.items.map((item) => item.title)).toEqual(["All day", "Early", "Late"]);
    expect(agenda.items[1]).toMatchObject({ status: "tentative", calendarRef: refs["second@example.test"], calendarDisplayName: "Second" });
    expect(new Set(google.listRequests.map((request) => request.calendarId)))
      .toEqual(new Set(["primary@example.test", "second@example.test"]));
    expect(google.listRequests.every((request) => request.timeZone === query.timeZone && request.timeMin === query.from && request.timeMax === query.to)).toBe(true);
    expect(JSON.stringify(agenda)).not.toMatch(/example\.test|etag|"late"|"early"/u);
  });

  it("lets Central read but denies principals without calendar:read", async () => {
    const { db, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true }]);
    await expect(service.read(centralPrincipal(), query)).resolves.toMatchObject({ items: [] });
    const fitness: DelegatedPrincipal = { ...centralPrincipal(), serviceId: "telegram-gateway", scopes: [] };
    await expect(service.read(fitness, query)).rejects.toThrow("forbidden");
  });

  it("caps provider concurrency at four calendars", async () => {
    const { db, google, service } = await setup();
    const calendars = Array.from({ length: 7 }, (_, index) => ({
      providerId: `calendar-${index}@example.test`, displayName: `Calendar ${index}`, isPrimary: index === 0,
    }));
    await seedCalendars(db, calendars);
    google.listDelayMs = 15;
    await service.read(humanPrincipal(), query);
    expect(google.listRequests).toHaveLength(7);
    expect(google.maxInFlight).toBe(4);
  });

  it("deduplicates repeated provider events and reuses opaque references across reads", async () => {
    const { db, google, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true }]);
    google.pages.set("primary@example.test", [[googleEvent({ id: "same" })], [googleEvent({ id: "same" })]]);
    const first = await service.read(humanPrincipal(), query);
    const second = await service.read(humanPrincipal(), query);
    expect(first.items).toHaveLength(1);
    expect(second.items[0]!.eventRef).toBe(first.items[0]!.eventRef);
    const stored = await db.read((handle) => repository.resolveEvent(handle, actorId, first.items[0]!.eventRef));
    expect(stored).toMatchObject({ calendarRef: first.items[0]!.calendarRef });
    expect(JSON.stringify(stored)).not.toContain("same\"");
    await expect(db.read((handle) => repository.resolveEvent(handle, otherActorId, first.items[0]!.eventRef))).resolves.toBeNull();
  });

  it("rejects agenda windows longer than eight days and invalid time zones before any provider call", async () => {
    const { db, google, tokens, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true }]);
    await expect(service.read(humanPrincipal(), { ...query, to: "2026-10-20T00:00:01.000Z" })).rejects.toThrow("calendar_range_too_large");
    await expect(service.read(humanPrincipal(), { ...query, timeZone: "Mars/Olympus" })).rejects.toThrow("calendar_query_invalid");
    await expect(service.read(humanPrincipal(), { ...query, to: query.from })).rejects.toThrow("calendar_query_invalid");
    expect(google.listRequests).toHaveLength(0);
    expect(tokens.calls).toBe(0);
  });

  it("fails with calendar_result_too_large past 1,000 items without requesting further pages", async () => {
    const { db, google, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true }]);
    const page = (offset: number) => Array.from({ length: 250 }, (_, index) => googleEvent({ id: `event-${offset + index}` }));
    google.pages.set("primary@example.test", [page(0), page(250), page(500), page(750), page(1000), page(1250)]);
    await expect(service.read(humanPrincipal(), query)).rejects.toThrow("calendar_result_too_large");
    expect(google.listRequests).toHaveLength(5);
    expect(await db.read((handle) => handle.prepare("SELECT COUNT(*) AS count FROM calendar_event_refs").get<{ count: number }>()?.count)).toBe(0);
  });

  it("records success and normalized provider failures in safe connection health", async () => {
    const { db, google, clock, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true }]);
    await service.read(humanPrincipal(), query);
    expect(await db.read((handle) => repository.getConnection(handle, actorId))).toMatchObject({
      state: "available", lastSuccessAt: clock.now().toISOString(),
    });
    clock.advance(1_000);
    google.failures.set("listEvents", { code: "google_calendar_temporarily_unavailable" });
    await expect(service.read(humanPrincipal(), query)).rejects.toThrow("calendar_provider_temporarily_unavailable");
    const degraded = await db.read((handle) => repository.getConnection(handle, actorId));
    expect(degraded).toMatchObject({ state: "degraded", safeReasonCode: "provider_temporarily_unavailable" });
    google.failures.set("listEvents", { code: "google_calendar_reauthorization_required" });
    await expect(service.read(humanPrincipal(), query)).rejects.toThrow("calendar_reauthorization_required");
    expect(await db.read((handle) => repository.getConnection(handle, actorId))).toMatchObject({
      state: "requires_reauthorization", safeReasonCode: "reauthorization_required",
    });
  });

  it("returns an empty agenda when the actor has no read-enabled calendars", async () => {
    const { db, google, service } = await setup();
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, readEnabled: false, writeEnabled: true }]);
    await expect(service.read(humanPrincipal(), query)).resolves.toMatchObject({ items: [] });
    expect(google.listRequests).toHaveLength(0);
  });
});
