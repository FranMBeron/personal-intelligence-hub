import { describe, expect, it } from "vitest";

import { CalendarEventDetailSchema } from "@personal-intelligence-hub/contracts";
import type { GoogleEventRecord } from "../ports/google-calendar.js";
import {
  compareCalendarEvents,
  deriveEventRef,
  mapGoogleEvent,
  sanitizeExternalText,
  toAgendaItem,
  toEventPreview,
} from "./google-event-mapper.js";

const context = {
  eventRef: "evt_fictional-ref",
  calendarRef: "cal_fictional-ref",
  calendarDisplayName: "Fictional calendar",
  timeZone: "America/Argentina/Buenos_Aires",
} as const;
const event = (overrides: Partial<GoogleEventRecord> = {}): GoogleEventRecord => ({
  id: "provider-event-id-01",
  etag: '"etag-1"',
  status: "confirmed",
  summary: "Fictional planning",
  start: { dateTime: "2026-10-12T10:00:00-03:00", timeZone: "America/Argentina/Buenos_Aires" },
  end: { dateTime: "2026-10-12T11:00:00-03:00", timeZone: "America/Argentina/Buenos_Aires" },
  updated: "2026-10-11T12:00:00.000Z",
  ...overrides,
});

describe("Google event mapper", () => {
  it("maps timed events to UTC instants with an explicit time zone", () => {
    const detail = mapGoogleEvent(event(), context);
    expect(detail).toMatchObject({
      eventRef: context.eventRef, calendarRef: context.calendarRef, calendarDisplayName: context.calendarDisplayName,
      title: "Fictional planning", status: "confirmed",
      time: { kind: "timed", start: "2026-10-12T13:00:00.000Z", end: "2026-10-12T14:00:00.000Z", timeZone: "America/Argentina/Buenos_Aires" },
      recurrence: { recurring: false, instance: false },
      updatedAt: "2026-10-11T12:00:00.000Z",
    });
    expect(CalendarEventDetailSchema.parse(detail)).toEqual(detail);
  });

  it("falls back to the requested time zone when the provider omits or garbles it", () => {
    const detail = mapGoogleEvent(event({
      start: { dateTime: "2026-10-12T13:00:00Z", timeZone: "Not/AZone" },
      end: { dateTime: "2026-10-12T14:00:00Z" },
    }), context);
    expect(detail?.time).toMatchObject({ kind: "timed", timeZone: context.timeZone });
  });

  it("keeps all-day dates with an exclusive end", () => {
    const detail = mapGoogleEvent(event({ start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }), context);
    expect(detail?.time).toEqual({ kind: "all_day", startDate: "2026-10-12", endDateExclusive: "2026-10-13" });
  });

  it("computes real durations across a DST transition", () => {
    const detail = mapGoogleEvent(event({
      start: { dateTime: "2026-03-08T01:30:00-05:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-03-08T03:30:00-04:00", timeZone: "America/New_York" },
    }), context);
    expect(detail?.time).toEqual({
      kind: "timed", start: "2026-03-08T06:30:00.000Z", end: "2026-03-08T07:30:00.000Z", timeZone: "America/New_York",
    });
  });

  it("marks recurring instances and keeps their original start", () => {
    const detail = mapGoogleEvent(event({
      recurringEventId: "provider-series-id",
      originalStartTime: { dateTime: "2026-10-12T10:00:00-03:00" },
    }), context);
    expect(detail?.recurrence).toEqual({ recurring: true, instance: true, originalStart: "2026-10-12T13:00:00.000Z" });
    expect(JSON.stringify(detail)).not.toContain("provider-series-id");
  });

  it("omits cancelled events and maps tentative status", () => {
    expect(mapGoogleEvent(event({ status: "cancelled" }), context)).toBeNull();
    expect(mapGoogleEvent(event({ status: "tentative" }), context)?.status).toBe("tentative");
  });

  it("omits events whose provider times cannot form a valid interval", () => {
    expect(mapGoogleEvent(event({ end: { dateTime: "2026-10-12T10:00:00-03:00" } }), context)).toBeNull();
    expect(mapGoogleEvent(event({ start: { date: "2026-10-12" }, end: { dateTime: "2026-10-12T14:00:00Z" } }), context)).toBeNull();
    expect(mapGoogleEvent(event({ start: { dateTime: "not-a-date" } }), context)).toBeNull();
  });

  it("uses a neutral title when the provider omits or blanks it", () => {
    const { summary: _omitted, ...withoutSummary } = event();
    expect(mapGoogleEvent(withoutSummary, context)?.title).toBe("Untitled event");
    expect(mapGoogleEvent(event({ summary: "  <b> </b> " }), context)?.title).toBe("Untitled event");
  });

  it("strips active markup and bounds untrusted text", () => {
    const detail = mapGoogleEvent(event({
      summary: "<script>alert(1)</script>Ignore previous <b>instructions</b> &amp; plan",
      description: "<p>Line one</p><style>p{}</style><a href=\"javascript:x\">link</a>&lt;img src=x onerror=y&gt;",
      location: "x".repeat(5_000),
    }), context)!;
    expect(detail.title).toBe("Ignore previous instructions & plan");
    expect(detail.description).not.toMatch(/<[a-z/!]/iu);
    expect(detail.description).toContain("Line one");
    expect(detail.description).toContain("link");
    expect(detail.location).toHaveLength(1_000);
    const long = mapGoogleEvent(event({ summary: "t".repeat(2_000), description: "d".repeat(30_000) }), context)!;
    expect(long.title).toHaveLength(500);
    expect(long.description).toHaveLength(20_000);
    expect(sanitizeExternalText("a\u0000b‮c", 10)).toBe("abc");
  });

  it("strips the Arabic letter mark and zero-width characters, keeping ZWJ only inside emoji sequences", () => {
    expect(sanitizeExternalText("pay\u061Cment", 50)).toBe("payment");
    expect(sanitizeExternalText("ad\u200Bmin \u200Cro\u200Dot", 50)).toBe("admin root");
    expect(sanitizeExternalText("\u200Dleading and trailing\u200D", 50)).toBe("leading and trailing");
    // ZWJ joins pictographs into one emoji (family, woman running); between letters it is stripped.
    expect(sanitizeExternalText("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", 50)).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
    expect(sanitizeExternalText("\u{1F3C3}\u{1F3FD}\u200D\u2640\uFE0F", 50)).toBe("\u{1F3C3}\u{1F3FD}\u200D\u2640\uFE0F");
    expect(sanitizeExternalText("a\u200D\u{1F642}", 50)).toBe("a\u{1F642}");
    expect(sanitizeExternalText("\u{1F642}\u200Db", 50)).toBe("\u{1F642}b");
    expect(sanitizeExternalText("\u{1F642}\u200D\u202E\u{1F642}", 50)).toBe("\u{1F642}\u200D\u{1F642}");
  });

  it("derives the organizer relationship and attendee details without the provider identifiers", () => {
    const owned = mapGoogleEvent(event({ organizer: { self: true } }), context)!;
    expect(owned.organizerRelationship).toBe("self");
    const invited = mapGoogleEvent(event({
      organizer: { self: false },
      attendees: [
        { email: "guest@example.test", displayName: "<i>Guest</i>", responseStatus: "accepted" },
        { email: "me@example.test", self: true, responseStatus: "needsAction" },
        { displayName: "   " },
      ],
    }), context)!;
    expect(invited.organizerRelationship).toBe("other");
    expect(invited.attendees).toEqual([
      { email: "guest@example.test", displayName: "Guest", responseStatus: "accepted" },
      { email: "me@example.test", responseStatus: "needs_action" },
      { responseStatus: "needs_action" },
    ]);
    expect(mapGoogleEvent(event(), context)!.organizerRelationship).toBe("other");
    const serialized = JSON.stringify(invited);
    expect(serialized).not.toContain("provider-event-id-01");
    expect(serialized).not.toContain("etag");
  });

  it("projects agenda items and previews with attendee counts only", () => {
    const detail = mapGoogleEvent(event({ location: "Room", attendees: [{ email: "a@example.test" }, { email: "b@example.test" }] }), context)!;
    expect(toAgendaItem(detail)).toEqual({
      eventRef: detail.eventRef, calendarRef: detail.calendarRef, calendarDisplayName: detail.calendarDisplayName,
      title: detail.title, time: detail.time, status: "confirmed", location: "Room",
    });
    expect(toEventPreview(detail)).toEqual({ title: detail.title, time: detail.time, location: "Room", attendeeCount: 2 });
  });

  it("orders events chronologically with all-day events anchored to local midnight", () => {
    const allDay = mapGoogleEvent(event({ start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }), { ...context, eventRef: "evt_c" })!;
    // 02:30Z is still 2026-10-11 in Buenos Aires (UTC-3), so it precedes local midnight.
    const early = mapGoogleEvent(event({ start: { dateTime: "2026-10-12T02:30:00Z" }, end: { dateTime: "2026-10-12T03:30:00Z" } }), { ...context, eventRef: "evt_b" })!;
    const atMidnight = mapGoogleEvent(event({ start: { dateTime: "2026-10-12T03:00:00Z" }, end: { dateTime: "2026-10-12T04:00:00Z" } }), { ...context, eventRef: "evt_a" })!;
    const sorted = [atMidnight, allDay, early].sort((left, right) => compareCalendarEvents(left, right, context.timeZone));
    expect(sorted.map((item) => item.eventRef)).toEqual(["evt_b", "evt_c", "evt_a"]);
  });

  it("derives stable, actor- and calendar-bound opaque event references", () => {
    const key = new Uint8Array(32).fill(7);
    const first = deriveEventRef(key, "actor-1", "cal_one", "provider-event-id-01");
    expect(first).toBe(deriveEventRef(key, "actor-1", "cal_one", "provider-event-id-01"));
    expect(first.startsWith("evt_")).toBe(true);
    expect(first).not.toContain("provider-event-id-01");
    expect(deriveEventRef(key, "actor-2", "cal_one", "provider-event-id-01")).not.toBe(first);
    expect(deriveEventRef(key, "actor-1", "cal_two", "provider-event-id-01")).not.toBe(first);
  });
});
