import { createHmac } from "node:crypto";

import { z } from "zod";

import type {
  CalendarAgendaItem,
  CalendarAttendee,
  CalendarEventDetail,
  CalendarEventPreview,
  CalendarEventTime,
} from "@personal-intelligence-hub/contracts";
import type { GoogleEventRecord } from "../ports/google-calendar.js";

/**
 * Event titles, descriptions, locations, organizer and attendee data are untrusted external
 * content. This module turns a provider record into the safe contract projection: markup is
 * removed, sizes are bounded, provider identifiers never appear, and nothing here is interpreted.
 */
export type EventMappingContext = Readonly<{
  eventRef: string;
  calendarRef: string;
  calendarDisplayName: string;
  /** Requested IANA zone; used when the provider omits a valid zone for a timed event. */
  timeZone: string;
}>;

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 20_000;
const LOCATION_MAX = 1_000;
const DISPLAY_NAME_MAX = 200;
const UNTITLED = "Untitled event";
const EmailSchema = z.email().max(320);
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'",
};

const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6}|#39);/giu, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x") || /^#[0-9]+$/u.test(lower)) {
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[lower] ?? match;
  });

const stripTags = (value: string): string => {
  let current = value;
  // Repeat so markup revealed by entity decoding or nested fragments cannot survive.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = current
      .replace(/<(script|style|iframe|object|embed|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<\s*br\s*\/?>/giu, "\n")
      .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/giu, "\n")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<\/?[a-z!][^>]*>/giu, " ");
    const decoded = decodeEntities(next);
    if (decoded === current) return decoded;
    current = decoded;
  }
  return current;
};
// Any angle bracket that survives tag removal is neutralized, so no markup can be reassembled.
const neutralizeBrackets = (value: string): string => value.replace(/</gu, "\u2039").replace(/>/gu, "\u203a");

const truncate = (value: string, max: number): string => {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
};

/**
 * C0/C1 controls (except tab/newline), DEL, the Arabic letter mark (U+061C), zero-width space and
 * non-joiner (U+200B, U+200C), LRM/RLM, bidi embeddings/overrides (U+202A-U+202E), isolates
 * (U+2066-U+2069) and BOM. None changes legitimate meaning; all can hide or reorder text.
 */
const INVISIBLE_OR_BIDI = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
/**
 * Zero-width joiner (U+200D) is kept only where it joins two pictographs into one emoji (for
 * example family or gendered-activity sequences; a skin-tone modifier or VS16 may precede it).
 * Anywhere else it is invisible and stripped, so it cannot split or disguise words.
 */
const STRAY_ZWJ = /(?<!\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F]?)\u200d|\u200d(?!\p{Extended_Pictographic})/gu;

/** Removes markup, control, zero-width and bidirectional-override characters, then bounds the text length. */
export const sanitizeExternalText = (value: string, max: number, multiline = false): string => {
  const stripped = neutralizeBrackets(stripTags(value)).replace(INVISIBLE_OR_BIDI, "").replace(STRAY_ZWJ, "");
  const normalized = multiline
    ? stripped.replace(/[ \t ]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim()
    : stripped.replace(/\s+/gu, " ").trim();
  return truncate(normalized, max);
};

const optionalText = (value: string | undefined, max: number, multiline = false): string | undefined => {
  if (value === undefined) return undefined;
  const sanitized = sanitizeExternalText(value, max, multiline);
  return sanitized.length === 0 ? undefined : sanitized;
};

const validTimeZone = (timeZone: string | undefined): timeZone is string => {
  if (timeZone === undefined || timeZone.length === 0 || timeZone.length > 120) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const isoDate = (value: string | undefined): value is string =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const instant = (value: string | undefined): string | undefined => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

const mapTime = (event: GoogleEventRecord, fallbackTimeZone: string): CalendarEventTime | null => {
  if (event.start.dateTime !== undefined || event.end.dateTime !== undefined) {
    const start = instant(event.start.dateTime);
    const end = instant(event.end.dateTime);
    if (start === undefined || end === undefined || Date.parse(end) <= Date.parse(start)) return null;
    const timeZone = validTimeZone(event.start.timeZone) ? event.start.timeZone : fallbackTimeZone;
    return { kind: "timed", start, end, timeZone };
  }
  if (!isoDate(event.start.date) || !isoDate(event.end.date) || event.end.date <= event.start.date) return null;
  return { kind: "all_day", startDate: event.start.date, endDateExclusive: event.end.date };
};

const responseStatus = (value: string | undefined): CalendarAttendee["responseStatus"] =>
  value === "accepted" || value === "declined" || value === "tentative" ? value : "needs_action";

const mapAttendee = (attendee: NonNullable<GoogleEventRecord["attendees"]>[number]): CalendarAttendee => {
  const displayName = optionalText(attendee.displayName, DISPLAY_NAME_MAX);
  const email = attendee.email !== undefined && EmailSchema.safeParse(attendee.email).success ? attendee.email : undefined;
  return {
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
    responseStatus: responseStatus(attendee.responseStatus),
  };
};

/** Returns null for cancelled events and for provider records that cannot form a valid interval. */
export const mapGoogleEvent = (event: GoogleEventRecord, context: EventMappingContext): CalendarEventDetail | null => {
  if (event.status === "cancelled") return null;
  const time = mapTime(event, context.timeZone);
  if (time === null) return null;
  const updatedAt = instant(event.updated);
  if (updatedAt === undefined) return null;
  const description = optionalText(event.description, DESCRIPTION_MAX, true);
  const location = optionalText(event.location, LOCATION_MAX);
  const originalStart = event.recurringEventId === undefined ? undefined : instant(event.originalStartTime?.dateTime);
  const recurring = event.recurringEventId !== undefined;
  return {
    eventRef: context.eventRef,
    calendarRef: context.calendarRef,
    calendarDisplayName: sanitizeExternalText(context.calendarDisplayName, DISPLAY_NAME_MAX) || "Unnamed calendar",
    title: optionalText(event.summary, TITLE_MAX) ?? UNTITLED,
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
    time,
    status: event.status,
    organizerRelationship: event.organizer?.self === true ? "self" : "other",
    attendees: (event.attendees ?? []).map(mapAttendee),
    recurrence: { recurring, instance: recurring, ...(originalStart === undefined ? {} : { originalStart }) },
    updatedAt,
  };
};

export const toAgendaItem = (detail: CalendarEventDetail): CalendarAgendaItem => ({
  eventRef: detail.eventRef,
  calendarRef: detail.calendarRef,
  calendarDisplayName: detail.calendarDisplayName,
  title: detail.title,
  time: detail.time,
  status: detail.status,
  ...(detail.location === undefined ? {} : { location: detail.location }),
});

/**
 * What a human reviews before confirming: every guest email and the description are shown, never
 * just a count, so a proposal cannot quietly send event content to an unseen recipient.
 */
export const toEventPreview = (
  detail: Pick<CalendarEventDetail, "title" | "time" | "location" | "description"> & Readonly<{ attendees: readonly Readonly<{ email?: string | undefined }>[] }>,
): CalendarEventPreview => ({
  title: detail.title,
  time: detail.time,
  ...(detail.location === undefined ? {} : { location: detail.location }),
  ...(detail.description === undefined ? {} : { description: detail.description }),
  attendeeCount: detail.attendees.length,
  attendeeEmails: detail.attendees.flatMap((attendee) => (attendee.email === undefined ? [] : [attendee.email])),
});

/** Epoch milliseconds of local midnight for an ISO date in an IANA zone. */
export const zonedMidnight = (date: string, timeZone: string): number => {
  const utcGuess = Date.parse(`${date}T00:00:00Z`);
  const offsetAt = (epoch: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(epoch));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - epoch;
  };
  const first = utcGuess - offsetAt(utcGuess);
  return utcGuess - offsetAt(first);
};

const startOf = (time: CalendarEventTime, timeZone: string): number =>
  time.kind === "timed" ? Date.parse(time.start) : zonedMidnight(time.startDate, timeZone);
const endOf = (time: CalendarEventTime, timeZone: string): number =>
  time.kind === "timed" ? Date.parse(time.end) : zonedMidnight(time.endDateExclusive, timeZone);

/** Stable chronological order: start, all-day first on ties, end, then the opaque reference. */
export const compareCalendarEvents = (
  left: Pick<CalendarEventDetail, "time" | "eventRef">,
  right: Pick<CalendarEventDetail, "time" | "eventRef">,
  timeZone: string,
): number => {
  const byStart = startOf(left.time, timeZone) - startOf(right.time, timeZone);
  if (byStart !== 0) return byStart;
  if (left.time.kind !== right.time.kind) return left.time.kind === "all_day" ? -1 : 1;
  const byEnd = endOf(left.time, timeZone) - endOf(right.time, timeZone);
  if (byEnd !== 0) return byEnd;
  return left.eventRef < right.eventRef ? -1 : left.eventRef > right.eventRef ? 1 : 0;
};

/** Opaque, stable event reference bound to the actor and the opaque calendar reference. */
export const deriveEventRef = (
  blindIndexKey: Uint8Array,
  actorId: string,
  calendarRef: string,
  providerEventId: string,
): string =>
  "evt_" + createHmac("sha256", blindIndexKey)
    .update("calendar-event-ref:v1\0", "utf8")
    .update(`${actorId}\0${calendarRef}\0${providerEventId}`, "utf8")
    .digest("base64url");
