import { vi } from "vitest";

import type { CalendarApi } from "./calendar-client";

/** Typed fake for component tests: every method fails loudly unless the test supplies it. */
export const fakeCalendarClient = (overrides: Partial<CalendarApi> = {}) => {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error(`Unexpected calendar call: ${name}`); });
  const client = {
    status: unexpected("status"),
    startAuthorization: unexpected("startAuthorization"),
    bootstrap: unexpected("bootstrap"),
    disconnect: unexpected("disconnect"),
    calendars: unexpected("calendars"),
    selection: unexpected("selection"),
    updateSelection: unexpected("updateSelection"),
    proposal: unexpected("proposal"),
    propose: unexpected("propose"),
    confirm: unexpected("confirm"),
    reject: unexpected("reject"),
    ...overrides,
  };
  return client as unknown as CalendarApi & { [K in keyof CalendarApi]: ReturnType<typeof vi.fn> };
};
