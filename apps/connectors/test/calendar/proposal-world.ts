import type { ConnectorDatabase } from "../../src/foundation/database.js";
import { CalendarEventReader } from "../../src/calendar/application/calendar-event-reader.js";
import { createCalendarChangeServices } from "../../src/calendar/application/change-proposal-service.js";
import type { GoogleEventRecord } from "../../src/calendar/ports/google-calendar.js";
import {
  FakeGoogleCalendar,
  TestClock,
  actorId,
  fakeTokens,
  googleEvent,
  keyring,
  openTestDatabase,
  repository,
  seedCalendars,
  seedConnection,
} from "./fixtures.js";

export const PRIMARY = "primary@example.test";
export const SECONDARY = "secondary@example.test";
export const SELF_EMAIL = "me@example.test";
export const window = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", timeZone: "UTC" };

/** Fictional events: one the actor organizes, one invitation, one recurring instance and its series master. */
export const ownedEvent = googleEvent({
  id: "owned-event", etag: '"owned-1"', summary: "Owned planning", organizer: { self: true },
  start: { dateTime: "2026-10-12T15:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-12T16:00:00Z", timeZone: "UTC" },
  attendees: [{ email: SELF_EMAIL, self: true, responseStatus: "accepted" }, { email: "guest@example.test", responseStatus: "needsAction" }],
});
export const invitation = googleEvent({
  id: "invited-event", etag: '"invite-1"', summary: "Invited review", organizer: { self: false },
  start: { dateTime: "2026-10-12T17:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-12T18:00:00Z", timeZone: "UTC" },
  attendees: [{ email: "organizer@example.test", responseStatus: "accepted" }, { email: SELF_EMAIL, self: true, responseStatus: "needsAction" }],
});
export const seriesMaster = googleEvent({
  id: "series-master", etag: '"master-1"', summary: "Weekly sync", organizer: { self: true },
  start: { dateTime: "2026-10-05T19:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-05T19:30:00Z", timeZone: "UTC" },
});
export const seriesInstance = googleEvent({
  id: "series-master_20261012T190000Z", etag: '"instance-1"', summary: "Weekly sync", organizer: { self: true },
  recurringEventId: "series-master", originalStartTime: { dateTime: "2026-10-12T19:00:00Z" },
  start: { dateTime: "2026-10-12T19:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-12T19:30:00Z", timeZone: "UTC" },
});
export const secondaryEvent = googleEvent({
  id: "secondary-event", etag: '"secondary-1"', summary: "Read-only item", organizer: { self: true },
});

export type ProposalWorld = Awaited<ReturnType<typeof createProposalWorld>>;

export const buildServices = (db: ConnectorDatabase, google: FakeGoogleCalendar, clock: TestClock) => {
  const tokens = fakeTokens(db);
  const reader = new CalendarEventReader({ database: db, repository, tokens, google, keyring, clock: clock.now });
  let counter = 0;
  const services = createCalendarChangeServices({
    database: db, repository, reader, google, keyring, clock: clock.now,
    idGenerator: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    proposalTtlSeconds: 900,
  });
  return { tokens, reader, ...services };
};

export const createProposalWorld = async () => {
  const fixture = await openTestDatabase();
  const { db } = fixture;
  await seedConnection(db);
  const refs = await seedCalendars(db, [
    { providerId: PRIMARY, displayName: "Primary", isPrimary: true, readEnabled: true, writeEnabled: true, role: "owner" },
    { providerId: SECONDARY, displayName: "Secondary", readEnabled: true, writeEnabled: false, role: "writer" },
  ]);
  const google = new FakeGoogleCalendar();
  google.calendars = [
    { id: PRIMARY, summary: "Primary", primary: true, accessRole: "owner", timeZone: "America/Argentina/Buenos_Aires" },
    { id: SECONDARY, summary: "Secondary", primary: false, accessRole: "writer" },
  ];
  const primaryEvents: GoogleEventRecord[] = [ownedEvent, invitation, seriesInstance];
  google.pages.set(PRIMARY, [primaryEvents]);
  google.pages.set(SECONDARY, [[secondaryEvent]]);
  for (const event of [...primaryEvents, seriesMaster]) google.put(PRIMARY, event);
  google.put(SECONDARY, secondaryEvent);
  const clock = new TestClock();
  const services = buildServices(db, google, clock);
  const listed = await services.reader.collect(actorId, window, 100);
  const eventRefs = Object.fromEntries(listed.map((item) => [item.title, item.eventRef])) as Record<string, string>;
  return { ...fixture, google, clock, refs, eventRefs, ...services };
};

export const auditRows = (db: ConnectorDatabase) => db.read((handle) =>
  handle.prepare("SELECT * FROM calendar_change_audit WHERE proposal_id IS NOT NULL ORDER BY occurred_at, rowid").all<Record<string, unknown>>());

export const draft = {
  title: "Fictional new meeting",
  time: { kind: "timed" as const, start: "2026-10-13T14:00:00.000Z", end: "2026-10-13T15:00:00.000Z", timeZone: "America/Argentina/Buenos_Aires" },
  attendees: [{ email: "guest@example.test" }],
};
