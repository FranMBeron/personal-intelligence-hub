import { CalendarAgendaQuerySchema, type DelegatedPrincipal } from "@personal-intelligence-hub/contracts";

import type { CalendarReadWindow } from "./calendar-event-reader.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fail = (code: string): never => { throw new Error(code); };

/** Calendar reads need calendar:read; Central holds it, Fitness, Finanzas and Telegram do not. */
export const requireCalendarRead = (principal: DelegatedPrincipal): void => {
  if (!principal.scopes.includes("calendar:read")) fail("forbidden");
};

/** Validates the strict query window (IANA zone, ordered instants) and its maximum length. */
export const parseReadWindow = (query: CalendarReadWindow, maxDays: number): CalendarReadWindow => {
  const parsed = CalendarAgendaQuerySchema.safeParse({ from: query.from, to: query.to, timeZone: query.timeZone });
  if (!parsed.success) return fail("calendar_query_invalid");
  const from = new Date(parsed.data.from).toISOString();
  const to = new Date(parsed.data.to).toISOString();
  if (Date.parse(to) - Date.parse(from) > maxDays * DAY_MS) return fail("calendar_range_too_large");
  return { from, to, timeZone: parsed.data.timeZone };
};
