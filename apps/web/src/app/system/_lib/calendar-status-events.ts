import type { CalendarSourceStatus } from "@personal-intelligence-hub/contracts";

/**
 * In-page notification of a Calendar status this view itself learned (connect, bootstrap, refresh,
 * disconnect), so sibling Sistema slots stay consistent without the page having to wire them together.
 * It carries only the already validated safe status; nothing leaves the browser tab.
 */
const channel = new EventTarget();
const CHANGE = "calendar-status";

export const publishCalendarStatus = (status: CalendarSourceStatus): void => {
  channel.dispatchEvent(new CustomEvent<CalendarSourceStatus>(CHANGE, { detail: status }));
};

export const subscribeCalendarStatus = (listener: (status: CalendarSourceStatus) => void): (() => void) => {
  const handler = (event: Event) => listener((event as CustomEvent<CalendarSourceStatus>).detail);
  channel.addEventListener(CHANGE, handler);
  return () => channel.removeEventListener(CHANGE, handler);
};
