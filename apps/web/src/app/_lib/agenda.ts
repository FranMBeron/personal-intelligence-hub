import type { CalendarAgenda, CalendarAgendaItem, CalendarSourceStatus } from "@personal-intelligence-hub/contracts";

import type { Loadable } from "../system/_lib/system-view";

import { addDays, formatClock } from "./time-format";

/**
 * Deterministic local-day projection. Every calculation uses an explicit IANA zone through
 * `Intl.DateTimeFormat#formatToParts`; nothing reads the host zone (`getHours`, `getDate`, `toLocaleString` without a zone).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Parts = Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }>;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const partsFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
};

export const zonedParts = (instant: Date, timeZone: string): Parts => {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
};

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** The user's calendar date (YYYY-MM-DD) at `instant` in `timeZone`. */
export const localDayKey = (instant: Date, timeZone: string): string => {
  const parts = zonedParts(instant, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
};

/** Offset (local wall clock minus UTC) in milliseconds at `instant`. */
const offsetAt = (instant: number, timeZone: string): number => {
  const parts = zonedParts(new Date(instant), timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
};

/** First instant whose local date is `dayKey`; handles DST shifts and zones that skip local midnight. */
const startOfLocalDay = (dayKey: string, timeZone: string): number => {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  const wallMidnight = Date.UTC(year, month - 1, day);
  let candidate = wallMidnight - offsetAt(wallMidnight, timeZone);
  candidate = wallMidnight - offsetAt(candidate, timeZone);
  // Local midnight may not exist (spring-forward at 00:00): move forward to the first instant of the day.
  for (let guard = 0; guard < 4 && localDayKey(new Date(candidate), timeZone) < dayKey; guard += 1) candidate += HOUR;
  // Or the candidate may be late within the day: move back while the previous minute is still the same day.
  for (let guard = 0; guard < 4 && localDayKey(new Date(candidate - MINUTE), timeZone) === dayKey; guard += 1) candidate -= HOUR;
  // Refine to the minute boundary after any coarse hour stepping.
  while (localDayKey(new Date(candidate), timeZone) < dayKey) candidate += MINUTE;
  while (localDayKey(new Date(candidate - MINUTE), timeZone) === dayKey) candidate -= MINUTE;
  return candidate;
};

/** UTC instants bounding the local day: `[from, to)`. A DST day is 23 or 25 hours long. */
export const localDayBounds = (dayKey: string, timeZone: string): Readonly<{ from: string; to: string }> => ({
  from: new Date(startOfLocalDay(dayKey, timeZone)).toISOString(),
  to: new Date(startOfLocalDay(addDays(dayKey, 1), timeZone)).toISOString(),
});

/** Agenda query for the user's current local day; the UTC window contains the whole local day. */
export const agendaRequestWindow = (now: Date, timeZone: string): Readonly<{ from: string; to: string; timeZone: string }> => ({
  ...localDayBounds(localDayKey(now, timeZone), timeZone),
  timeZone,
});

export type AgendaPhase = "past" | "current" | "upcoming";

export type AgendaRow = Readonly<{
  /** Unique within a view: the same event can be visible through more than one selected calendar. */
  key: string;
  eventRef: string;
  title: string;
  calendarDisplayName: string;
  location: string | null;
  tentative: boolean;
  timeLabel: string;
  /** ISO instant for timed rows; null for all-day rows. */
  startsAt: string | null;
  phase: AgendaPhase | null;
}>;

export type AgendaView = Readonly<{
  dayKey: string;
  timeZone: string;
  generatedAt: string;
  allDay: readonly AgendaRow[];
  timed: readonly AgendaRow[];
  current: AgendaRow | null;
  next: AgendaRow | null;
  isEmpty: boolean;
  /** False when the agenda's requested window does not contain the whole local day; emptiness is then unknown. */
  coversDay: boolean;
}>;

const visibleStatuses: ReadonlySet<string> = new Set(["confirmed", "tentative"]);

const baseRow = (item: CalendarAgendaItem) => ({
  key: `${item.calendarRef}\u0000${item.eventRef}`,
  eventRef: item.eventRef,
  title: item.title,
  calendarDisplayName: item.calendarDisplayName,
  location: item.location === undefined || item.location.trim() === "" ? null : item.location,
  tentative: item.status === "tentative",
});

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Projects an agenda onto the user's local day in `timeZone` at `now`. */
export const buildAgendaView = (agenda: CalendarAgenda, now: Date, timeZone: string): AgendaView => {
  const dayKey = localDayKey(now, timeZone);
  const dayStart = startOfLocalDay(dayKey, timeZone);
  const dayEnd = startOfLocalDay(addDays(dayKey, 1), timeZone);
  const nowMs = now.getTime();
  const items = agenda.items.filter((item) => visibleStatuses.has(item.status));

  const allDay = items
    .filter((item): item is CalendarAgendaItem & { time: { kind: "all_day" } } => item.time.kind === "all_day")
    // Calendar dates compare as strings; the exclusive end date is never shown.
    .filter((item) => item.time.startDate <= dayKey && dayKey < item.time.endDateExclusive)
    .toSorted((left, right) => compareText(left.title, right.title) || compareText(left.eventRef, right.eventRef))
    .map((item): AgendaRow => ({ ...baseRow(item), timeLabel: "Todo el día", startsAt: null, phase: null }));

  const timedItems = items
    .filter((item): item is CalendarAgendaItem & { time: { kind: "timed" } } => item.time.kind === "timed")
    .map((item) => ({ item, start: Date.parse(item.time.start), end: Date.parse(item.time.end) }))
    .filter(({ start, end }) => start < dayEnd && end > dayStart)
    .toSorted((left, right) => left.start - right.start || left.end - right.end
      || compareText(left.item.title, right.item.title) || compareText(left.item.eventRef, right.item.eventRef));

  const timed = timedItems.map(({ item, start, end }): AgendaRow => {
    const from = start < dayStart ? "Desde ayer" : formatClock(item.time.start, timeZone);
    const to = end > dayEnd ? "continúa mañana" : formatClock(item.time.end, timeZone);
    const phase: AgendaPhase = end <= nowMs ? "past" : start <= nowMs ? "current" : "upcoming";
    return { ...baseRow(item), timeLabel: `${from} – ${to}`, startsAt: item.time.start, phase };
  });

  return {
    dayKey,
    timeZone,
    generatedAt: agenda.generatedAt,
    allDay,
    timed,
    current: timed.find((row) => row.phase === "current") ?? null,
    next: timed.find((row) => row.phase === "upcoming") ?? null,
    isEmpty: allDay.length === 0 && timed.length === 0,
    coversDay: Date.parse(agenda.from) <= dayStart && Date.parse(agenda.to) >= dayEnd,
  };
};

/** Explicit agenda state for the Hoy panel; each source condition has its own honest presentation. */
export type AgendaResult =
  | Readonly<{ state: "available"; agenda: CalendarAgenda }>
  | Readonly<{ state: "stale"; agenda: CalendarAgenda }>
  | Readonly<{ state: "unconfigured" }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "reauthorization" }>
  | Readonly<{ state: "permission_denied" }>
  | Readonly<{ state: "attention" }>;

/**
 * Combines the calendar source status and the agenda read. The status decides availability and freshness;
 * the agenda is shown only when it was actually read.
 */
export const toAgendaResult = (status: Loadable<CalendarSourceStatus>, agenda: Loadable<CalendarAgenda>): AgendaResult => {
  if (status.state === "not_configured" || agenda.state === "not_configured") return { state: "unconfigured" };
  if (status.state === "loaded") {
    const source = status.value;
    if (source.state === "not_configured") return { state: "unconfigured" };
    if (source.state === "requires_reauthorization") return { state: "reauthorization" };
    if (source.safeReasonCode === "provider_permission_denied") return { state: "permission_denied" };
    if (source.state === "requires_attention") return { state: "attention" };
    if (agenda.state !== "loaded") return { state: "unavailable" };
    return source.state === "available" && !source.stale
      ? { state: "available", agenda: agenda.value }
      : { state: "stale", agenda: agenda.value };
  }
  // Without a status we cannot vouch for freshness: a successful read is shown as last known data.
  return agenda.state === "loaded" ? { state: "stale", agenda: agenda.value } : { state: "unavailable" };
};
