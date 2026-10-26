// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calendarSelectionFixture,
  calendarStatusFixture,
  proposalFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { CalendarSection } from "./calendar-section";
import { fakeCalendarClient } from "./calendar-test-client";

afterEach(cleanup);

const connected = calendarStatusFixture({ state: "available", canRead: true, canProposeChanges: true, primaryCalendarConfigured: true });

describe("CalendarSection", () => {
  it("opens a selected proposal for review without confirming it", async () => {
    const client = fakeCalendarClient({ proposal: vi.fn(async () => proposalFixture()) });
    render(<CalendarSection initialStatus={connected} initialSelection={calendarSelectionFixture()} proposalId="proposal-fictional" timeZone="Etc/UTC" now="2026-10-12T12:00:00.000Z" client={client} />);
    await screen.findByRole("button", { name: "Confirmar cambio" });
    expect(client.proposal).toHaveBeenCalledWith("proposal-fictional", expect.any(AbortSignal));
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("renders no proposal review when none was selected", () => {
    render(<CalendarSection initialStatus={connected} initialSelection={calendarSelectionFixture()} proposalId={null} timeZone="Etc/UTC" now="2026-10-12T12:00:00.000Z" client={fakeCalendarClient()} />);
    expect(screen.getByRole("region", { name: "Google Calendar" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Revisar propuesta/ })).toBeNull();
  });

  it("shows an honest unavailable state when calendar status could not be read", () => {
    render(<CalendarSection initialStatus={null} initialSelection={null} proposalId={null} timeZone="Etc/UTC" now="2026-10-12T12:00:00.000Z" client={fakeCalendarClient()} />);
    expect(screen.getByRole("status").textContent).toMatch(/Calendar no disponible/);
    expect(screen.queryByRole("button", { name: "Conectar Google Calendar" })).toBeNull();
  });

  it("clears an open proposal after an explicit disconnect", async () => {
    const client = fakeCalendarClient({
      proposal: vi.fn(async () => proposalFixture()),
      disconnect: vi.fn(async () => sourceStatusFixture({ id: "calendar", state: "not_configured" })),
      status: vi.fn(async () => calendarStatusFixture()),
    });
    render(<CalendarSection initialStatus={connected} initialSelection={calendarSelectionFixture()} proposalId="proposal-fictional" timeZone="Etc/UTC" now="2026-10-12T12:00:00.000Z" client={client} />);
    await screen.findByRole("button", { name: "Confirmar cambio" });
    fireEvent.click(screen.getByRole("button", { name: "Desconectar Google Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar desconexión" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirmar cambio" })).toBeNull());
  });
});
