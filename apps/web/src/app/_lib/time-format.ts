/** Formats an instant for display in an explicit IANA zone; never the host's local zone. */
export const formatInstant = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso));

export const formatClock = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));

/** True when `timeZone` is accepted by the platform's IANA database. */
export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone.trim() !== timeZone || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** Adds whole days to a calendar date (YYYY-MM-DD) without passing through any local or instant time. */
export const addDays = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** Formats a calendar date (YYYY-MM-DD) as a date, never as an instant shifted by a zone. */
export const formatCalendarDate = (date: string): string =>
  new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00.000Z`));
