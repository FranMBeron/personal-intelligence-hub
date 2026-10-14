import { afterEach, describe, expect, it } from "vitest";

import { CalendarEventDetailSchema, CalendarEventListSchema } from "@personal-intelligence-hub/contracts";
import {
  FakeGoogleCalendar,
  TestClock,
  actorId,
  centralPrincipal,
  closeTestDatabases,
  fakeTokens,
  googleEvent,
  humanPrincipal,
  keyring,
  openTestDatabase,
  otherActorId,
  repository,
  seedCalendars,
  seedConnection,
} from "../../../test/calendar/fixtures.js";
import { CalendarEventReader } from "./calendar-event-reader.js";
import { CalendarEventQueryServiceImpl } from "./event-query-service.js";

const query = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", timeZone: "UTC" };
const manyEvents = (count: number, prefix = "event") => Array.from({ length: count }, (_, index) => googleEvent({
  id: `${prefix}-${String(index).padStart(5, "0")}`,
  summary: `Fictional ${index}`,
  start: { dateTime: new Date(Date.parse("2026-10-02T00:00:00Z") + index * 60_000).toISOString() },
  end: { dateTime: new Date(Date.parse("2026-10-02T00:30:00Z") + index * 60_000).toISOString() },
}));
const chunk = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const setup = async () => {
  const { db } = await openTestDatabase();
  await seedConnection(db);
  await seedConnection(db, otherActorId);
  const google = new FakeGoogleCalendar();
  const clock = new TestClock();
  const tokens = fakeTokens(db);
  const reader = new CalendarEventReader({ database: db, repository, tokens, google, keyring, clock: clock.now });
  const makeService = () => new CalendarEventQueryServiceImpl({ reader, clock: clock.now });
  const refs = await seedCalendars(db, [
    { providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true },
  ]);
  return { db, google, clock, tokens, reader, makeService, service: makeService(), refs };
};

afterEach(closeTestDatabases);

describe("Calendar event query service", () => {
  it("pages a bounded snapshot 100 items at a time with an opaque cursor", async () => {
    const { google, service } = await setup();
    google.pages.set("primary@example.test", chunk(manyEvents(230), 250));
    const first = await service.list(humanPrincipal(), query);
    expect(CalendarEventListSchema.parse(first)).toEqual(first);
    expect(first.items).toHaveLength(100);
    const cursor = first.pageInfo.nextCursor!;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
    const second = await service.list(humanPrincipal(), { ...query, cursor });
    const third = await service.list(humanPrincipal(), { ...query, cursor: second.pageInfo.nextCursor! });
    expect(second.items).toHaveLength(100);
    expect(third.items).toHaveLength(30);
    expect(third.pageInfo).toEqual({});
    const titles = [...first.items, ...second.items, ...third.items].map((item) => item.title);
    expect(titles).toEqual(manyEvents(230).map((event) => event.summary));
    expect(google.listRequests).toHaveLength(1);
  });

  it("binds cursors to the actor and filter and expires them after 60 seconds or a restart", async () => {
    const { google, clock, service, makeService } = await setup();
    google.pages.set("primary@example.test", chunk(manyEvents(150), 250));
    const first = await service.list(humanPrincipal(), query);
    const cursor = first.pageInfo.nextCursor!;
    await expect(service.list(humanPrincipal(otherActorId), { ...query, cursor })).rejects.toThrow("calendar_cursor_expired");
    await expect(service.list(humanPrincipal(), { ...query, timeZone: "America/Argentina/Buenos_Aires", cursor })).rejects.toThrow("calendar_cursor_expired");
    await expect(service.list(humanPrincipal(), { ...query, to: "2026-10-31T00:00:00.000Z", cursor })).rejects.toThrow("calendar_cursor_expired");
    await expect(service.list(humanPrincipal(), { ...query, cursor: "unknown-cursor-value-000000000000000" })).rejects.toThrow("calendar_cursor_expired");
    await expect(makeService().list(humanPrincipal(), { ...query, cursor })).rejects.toThrow("calendar_cursor_expired");
    await expect(service.list(humanPrincipal(), { ...query, cursor })).resolves.toMatchObject({ items: expect.any(Array) });
    clock.advance(60_001);
    await expect(service.list(humanPrincipal(), { ...query, cursor })).rejects.toThrow("calendar_cursor_expired");
    expect(service.retainedSnapshotCount()).toBe(0);
  });

  it("reuses one cursor per page so replaying a cursor never mints new ones", async () => {
    const { google, service } = await setup();
    google.pages.set("primary@example.test", chunk(manyEvents(230), 250));
    const first = await service.list(humanPrincipal(), query);
    const cursor = first.pageInfo.nextCursor!;
    const nextCursors = new Set<string | undefined>();
    for (let replay = 0; replay < 1_000; replay += 1) {
      nextCursors.add((await service.list(humanPrincipal(), { ...query, cursor })).pageInfo.nextCursor);
    }
    expect(nextCursors.size).toBe(1);
    // 230 items have exactly two follow-up pages, so at most two cursors can ever exist.
    expect(service.retainedCursorCount()).toBe(2);
    await expect(service.list(humanPrincipal(), query)).resolves.toMatchObject({ pageInfo: { nextCursor: expect.any(String) } });
    expect(service.retainedCursorCount()).toBeLessThanOrEqual(2);
  });

  it("bounds retained snapshot bytes, evicting the oldest and refusing a single oversized result", async () => {
    const { google, reader, clock } = await setup();
    const heavy = manyEvents(150).map((event) => ({ ...event, description: "d".repeat(1_000) }));
    google.pages.set("primary@example.test", chunk(heavy, 250));
    const service = new CalendarEventQueryServiceImpl({
      reader, clock: clock.now, limits: { maxSnapshotBytes: 300_000, maxTotalSnapshotBytes: 400_000 },
    });
    const windows = ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"];
    const cursors: string[] = [];
    for (const to of windows) cursors.push((await service.list(humanPrincipal(), { ...query, to })).pageInfo.nextCursor!);
    expect(service.retainedSnapshotBytes()).toBeGreaterThan(150_000);
    expect(service.retainedSnapshotBytes()).toBeLessThanOrEqual(400_000);
    await expect(service.list(humanPrincipal(), { ...query, to: windows[0]!, cursor: cursors[0]! })).rejects.toThrow("calendar_cursor_expired");
    await expect(service.list(humanPrincipal(), { ...query, to: windows[2]!, cursor: cursors[2]! })).resolves.toMatchObject({ items: expect.any(Array) });

    const small = new CalendarEventQueryServiceImpl({
      reader, clock: clock.now, limits: { maxSnapshotBytes: 100_000, maxTotalSnapshotBytes: 400_000 },
    });
    await expect(small.list(humanPrincipal(), query)).rejects.toThrow("calendar_result_too_large");
    expect(small.retainedSnapshotBytes()).toBe(0);
  });

  it("stops at the 5,001st item without requesting the next page or retaining a snapshot", async () => {
    const { db, google, service } = await setup();
    const pages = chunk(manyEvents(5_250), 250);
    google.pages.set("primary@example.test", pages);
    await expect(service.list(humanPrincipal(), query)).rejects.toThrow("calendar_result_too_large");
    // Twenty full pages hold 5,000 items; the 21st page crosses 5,001 and its advertised next page is never requested.
    expect(google.listRequests).toHaveLength(21);
    expect(google.listRequests.at(-1)?.pageToken).toBe("page-20");
    expect(service.retainedSnapshotCount()).toBe(0);
    expect(await db.read((handle) => handle.prepare("SELECT COUNT(*) AS count FROM calendar_event_refs").get<{ count: number }>()?.count)).toBe(0);
  });

  it("rejects ranges over 366 days", async () => {
    const { service } = await setup();
    await expect(service.list(humanPrincipal(), { ...query, to: "2027-10-03T00:00:00.000Z" })).rejects.toThrow("calendar_range_too_large");
  });

  it("returns full event detail by opaque reference for Central and the owner only", async () => {
    const { db, google, service } = await setup();
    const invitation = googleEvent({
      id: "invited", summary: "Invitation", description: "<p>Agenda</p>", organizer: { self: false },
      attendees: [{ email: "organizer@example.test", responseStatus: "accepted" }, { email: "me@example.test", self: true }],
    });
    google.pages.set("primary@example.test", [[invitation]]);
    google.put("primary@example.test", invitation);
    const listed = await service.list(centralPrincipal(), query);
    const eventRef = listed.items[0]!.eventRef;
    const detail = await service.get(centralPrincipal(), eventRef);
    expect(CalendarEventDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({ title: "Invitation", description: "Agenda", organizerRelationship: "other" });
    expect(detail.attendees).toHaveLength(2);

    const before = google.listRequests.length;
    await expect(service.get(humanPrincipal(otherActorId), eventRef)).rejects.toThrow("calendar_event_not_found");
    await expect(service.get(humanPrincipal(), "evt_fabricated")).rejects.toThrow("calendar_event_not_found");
    expect(google.listRequests.length).toBe(before);

    google.events.get("primary@example.test")!.delete("invited");
    await expect(service.get(humanPrincipal(), eventRef)).rejects.toThrow("calendar_event_not_found");
    google.put("primary@example.test", { ...invitation, status: "cancelled" });
    await expect(service.get(humanPrincipal(), eventRef)).rejects.toThrow("calendar_event_not_found");
    await expect(db.read((handle) => repository.resolveEvent(handle, actorId, eventRef))).resolves.not.toBeNull();
  });

  it("does not serve events from a calendar that is no longer read-enabled", async () => {
    const { db, google, service } = await setup();
    const event = googleEvent({ id: "secondary-event" });
    const refs = await seedCalendars(db, [
      { providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true },
      { providerId: "second@example.test", displayName: "Second" },
    ]);
    google.pages.set("second@example.test", [[event]]);
    google.put("second@example.test", event);
    const listed = await service.list(humanPrincipal(), query);
    const eventRef = listed.items.find((item) => item.calendarRef === refs["second@example.test"])!.eventRef;
    await seedCalendars(db, [{ providerId: "primary@example.test", displayName: "Primary", isPrimary: true, writeEnabled: true }]);
    await expect(service.get(humanPrincipal(), eventRef)).rejects.toThrow("calendar_event_not_found");
  });
});
