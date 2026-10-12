import { describe, expect, it } from "vitest";

import {
  CalendarAgendaSchema,
  CalendarAuthorizationStartSchema,
  CalendarChangeProposalSchema,
  CalendarEventDetailSchema,
  CalendarEventListSchema,
  CalendarEventTimeSchema,
  CalendarEventsQuerySchema,
  CalendarSelectionEntrySchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  ConfirmCalendarChangeProposalBodySchema,
  CreateCalendarChangeProposalBodySchema,
  UpdateCalendarSelectionBodySchema,
} from "./calendar.js";

const timed = {
  kind: "timed",
  start: "2026-10-12T09:00:00-03:00",
  end: "2026-10-12T10:00:00-03:00",
  timeZone: "America/Argentina/Buenos_Aires",
} as const;

const selectionEntry = {
  calendarRef: "cal_local_1",
  displayName: "Trabajo",
  accessRole: "reader",
  readEnabled: true,
  writeEnabled: false,
  isPrimary: false,
} as const;

const eventDetail = {
  eventRef: "evt_local_1",
  calendarRef: "cal_local_1",
  calendarDisplayName: "Trabajo",
  title: "Reunión de ejemplo",
  time: timed,
  status: "confirmed",
  organizerRelationship: "self",
  attendees: [{ email: "fictional@example.test", responseStatus: "accepted" }],
  recurrence: { recurring: false, instance: false },
  updatedAt: "2026-10-12T08:00:00-03:00",
} as const;

const proposal = {
  id: "proposal_local_1",
  version: 0,
  status: "pending",
  summary: {
    operation: "create",
    calendarDisplayName: "Trabajo",
    timeZone: "America/Argentina/Buenos_Aires",
    recurrenceScope: "single",
    organizerRelationship: "self",
    guestNotification: "none",
    after: { title: "Reunión de ejemplo", time: timed, attendeeCount: 0 },
  },
  createdAt: "2026-10-12T08:00:00-03:00",
  expiresAt: "2026-10-12T08:15:00-03:00",
} as const;

describe("Calendar public contracts", () => {
  it("uses strict objects throughout public schemas", () => {
    expect(() => CalendarSourceStatusSchema.parse({
      state: "available", checkedAt: "2026-10-12T08:00:00Z", stale: false,
      canRead: true, canProposeChanges: true, primaryCalendarConfigured: true,
      additionalCalendarCount: 0, providerAccountId: "raw-google-id",
    })).toThrow();
    expect(() => CalendarSelectionEntrySchema.parse({ ...selectionEntry, providerId: "raw" })).toThrow();
    expect(() => CalendarEventDetailSchema.parse({ ...eventDetail, etag: "raw" })).toThrow();
  });

  it("discriminates timed and all-day values and requires exclusive all-day end dates", () => {
    expect(CalendarEventTimeSchema.parse(timed).kind).toBe("timed");
    expect(CalendarEventTimeSchema.parse({ kind: "all_day", startDate: "2026-10-12", endDateExclusive: "2026-10-13" })).toEqual({ kind: "all_day", startDate: "2026-10-12", endDateExclusive: "2026-10-13" });
    expect(() => CalendarEventTimeSchema.parse({ kind: "all_day", startDate: "2026-10-12", endDateExclusive: "2026-10-12" })).toThrow();
    expect(() => CalendarEventTimeSchema.parse({ ...timed, end: "2026-10-12T08:00:00-03:00" })).toThrow();
  });

  it("rejects write selection when the provider role is read-only", () => {
    expect(() => CalendarSelectionEntrySchema.parse({ ...selectionEntry, writeEnabled: true })).toThrow();
    expect(CalendarSelectionEntrySchema.parse({ ...selectionEntry, accessRole: "writer", writeEnabled: true }).writeEnabled).toBe(true);
  });

  it("returns selection entries under items and accepts independent flags", () => {
    expect(CalendarSelectionSchema.parse({ version: 0, items: [{ ...selectionEntry, readEnabled: false }] })).toEqual({ version: 0, items: [{ ...selectionEntry, readEnabled: false }] });
    expect(() => CalendarSelectionSchema.parse({ version: 0, calendars: [] })).toThrow();
    expect(UpdateCalendarSelectionBodySchema.parse({ expectedVersion: 0, calendars: [{ calendarRef: "cal_local_1", readEnabled: false, writeEnabled: true }] }).calendars[0]?.writeEnabled).toBe(true);
  });

  it("parses event query windows with an optional opaque cursor", () => {
    expect(CalendarEventsQuerySchema.parse({ from: "2026-10-12T00:00:00Z", to: "2026-10-13T00:00:00Z", timeZone: "UTC", cursor: "opaque_cursor" }).cursor).toBe("opaque_cursor");
    expect(() => CalendarEventsQuerySchema.parse({ from: "2026-10-13T00:00:00Z", to: "2026-10-12T00:00:00Z", timeZone: "UTC" })).toThrow();
  });

  it("keeps event pagination cursor at pageInfo.nextCursor", () => {
    expect(CalendarEventListSchema.parse({ items: [eventDetail], pageInfo: { nextCursor: "opaque_cursor" } }).pageInfo.nextCursor).toBe("opaque_cursor");
    expect(() => CalendarEventListSchema.parse({ items: [eventDetail], nextCursor: "opaque_cursor" })).toThrow();
  });

  it("validates authorization starts and proposal versions", () => {
    expect(CalendarAuthorizationStartSchema.parse({ authorizationUrl: "https://accounts.google.test/authorize", expiresAt: "2026-10-12T08:05:00Z" }).authorizationUrl).toMatch(/^https:/);
    expect(() => CalendarAuthorizationStartSchema.parse({ authorizationUrl: "http://accounts.google.test/authorize", expiresAt: "2026-10-12T08:05:00Z" })).toThrow();
    expect(() => CalendarChangeProposalSchema.parse({ ...proposal, version: -1 })).toThrow();
    expect(CalendarChangeProposalSchema.parse(proposal).version).toBe(0);
    expect(() => ConfirmCalendarChangeProposalBodySchema.parse({ expectedVersion: -1 })).toThrow();
  });

  it("models invitation responses as a separate operation from cancellation", () => {
    const body = { operation: "respond_invitation", eventRef: "evt_local_1", recurrenceScope: "single", response: "accepted", guestNotification: "none" };
    expect(CreateCalendarChangeProposalBodySchema.parse(body)).toMatchObject({ operation: "respond_invitation", response: "accepted" });
    expect(() => CreateCalendarChangeProposalBodySchema.parse({ operation: "cancel", eventRef: "evt_local_1", recurrenceScope: "single", response: "accepted", guestNotification: "none" })).toThrow();
  });

  it("accepts valid agenda and rejects public provider identifiers", () => {
    expect(CalendarAgendaSchema.parse({ timeZone: "America/Argentina/Buenos_Aires", from: "2026-10-12T00:00:00-03:00", to: "2026-10-13T00:00:00-03:00", generatedAt: "2026-10-12T08:00:00-03:00", items: [] }).items).toEqual([]);
    expect(() => CalendarAgendaSchema.parse({ timeZone: "UTC", from: "2026-10-12T00:00:00Z", to: "2026-10-13T00:00:00Z", generatedAt: "2026-10-12T08:00:00Z", items: [], googleId: "raw" })).toThrow();
  });
});
