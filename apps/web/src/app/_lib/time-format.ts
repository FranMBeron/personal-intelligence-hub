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
