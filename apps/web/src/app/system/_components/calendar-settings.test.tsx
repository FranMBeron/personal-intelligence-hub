// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarSelectionEntry } from "@personal-intelligence-hub/contracts";
import {
  calendarSelectionFixture,
  calendarStatusFixture,
  sourceStatusFixture,
} from "@personal-intelligence-hub/contracts/testing/connectors";
import { BffRequestError } from "../../_lib/bff-request";
import { CalendarSettings } from "./calendar-settings";
import { fakeCalendarClient } from "./calendar-test-client";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const entry = (overrides: Partial<CalendarSelectionEntry>): CalendarSelectionEntry => ({
  calendarRef: "cal-primary", displayName: "Principal", accessRole: "owner",
  readEnabled: true, writeEnabled: true, isPrimary: true, ...overrides,
});
const connected = calendarStatusFixture({ state: "available", canRead: true, canProposeChanges: true, primaryCalendarConfigured: true });
const authStart = { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional", expiresAt: "2026-10-12T12:10:00.000Z" };

describe("CalendarSettings connection", () => {
  it("starts authorization only on click and then offers an explicit browser link", async () => {
    const client = fakeCalendarClient({ startAuthorization: vi.fn(async () => authStart), status: vi.fn(async () => calendarStatusFixture()) });
    render(<CalendarSettings initialStatus={calendarStatusFixture()} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={client} />);
    expect(client.startAuthorization).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Continuar en navegador/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Conectar Google Calendar" }));
    const link = await screen.findByRole("link", { name: /Continuar en navegador/ });
    expect(client.startAuthorization).toHaveBeenCalledTimes(1);
    expect(link.getAttribute("href")).toBe(authStart.authorizationUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")?.split(" ").toSorted()).toEqual(["noopener", "noreferrer"]);
    expect(screen.getByText(/El enlace vence/).textContent).toContain("12:10");
    expect(document.body.innerHTML).not.toMatch(/refresh_token|access_token/);
  });

  it("refreshes status when the user returns, without reading tokens", async () => {
    const status = vi.fn(async () => connected);
    const client = fakeCalendarClient({ startAuthorization: vi.fn(async () => authStart), status, selection: vi.fn(async () => calendarSelectionFixture({ items: [entry({})], version: 1 })) });
    render(<CalendarSettings initialStatus={calendarStatusFixture()} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar Google Calendar" }));
    await screen.findByRole("link", { name: /Continuar en navegador/ });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("Conectado");
    expect(status).toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Continuar en navegador/ })).toBeNull();
  });

  it("polls a bounded number of times and stops on unmount", async () => {
    vi.useFakeTimers();
    const status = vi.fn(async () => calendarStatusFixture());
    const client = fakeCalendarClient({ startAuthorization: vi.fn(async () => authStart), status });
    const { unmount } = render(<CalendarSettings initialStatus={calendarStatusFixture()} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Conectar Google Calendar" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000 * 100); });
    const calls = status.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(24);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(status.mock.calls.length).toBe(calls);
  });

  it("explains a rejected or cancelled OAuth return and allows retrying", async () => {
    const client = fakeCalendarClient({ status: vi.fn(async () => calendarStatusFixture()) });
    render(<CalendarSettings initialStatus={calendarStatusFixture()} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" returnState="attention" client={client} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no se completó/);
    await waitFor(() => expect(client.status).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Conectar Google Calendar" })).toBeTruthy();
  });

  it("asks for reauthorization distinctly from a first connection", () => {
    render(<CalendarSettings initialStatus={calendarStatusFixture({ state: "requires_reauthorization", safeReasonCode: "reauthorization_required" })} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={fakeCalendarClient()} />);
    expect(screen.getByText("Requiere volver a autorizar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Volver a autorizar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar Google Calendar" })).toBeNull();
  });

  it("retries primary bootstrap once per click after a requires_attention callback", async () => {
    let release: () => void = () => undefined;
    const bootstrap = vi.fn(() => new Promise<ReturnType<typeof calendarStatusFixture>>((resolve) => { release = () => resolve(connected); }));
    const client = fakeCalendarClient({ bootstrap, selection: vi.fn(async () => calendarSelectionFixture({ items: [entry({})], version: 1 })) });
    render(<CalendarSettings initialStatus={calendarStatusFixture({ state: "requires_attention", safeReasonCode: "calendar_selection_required" })} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={client} />);
    const retry = screen.getByRole("button", { name: "Reintentar configuración" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await screen.findByText("Conectado");
    expect(await screen.findByRole("checkbox", { name: "Leer Principal" })).toBeTruthy();
  });

  it("disconnects only after an explicit second confirmation and clears stale selection", async () => {
    const onDisconnected = vi.fn();
    const disconnect = vi.fn(async () => sourceStatusFixture({ id: "calendar", state: "not_configured", lastSuccessAt: undefined }));
    const client = fakeCalendarClient({ disconnect, status: vi.fn(async () => calendarStatusFixture()) });
    render(<CalendarSettings initialStatus={connected} initialSelection={calendarSelectionFixture({ items: [entry({})], version: 1 })} timeZone="Etc/UTC" client={client} onDisconnected={onDisconnected} />);
    fireEvent.click(screen.getByRole("button", { name: "Desconectar Google Calendar" }));
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar desconexión" }));
    await screen.findByRole("button", { name: "Conectar Google Calendar" });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("checkbox", { name: "Leer Principal" })).toBeNull();
  });
});

describe("CalendarSettings selection", () => {
  const selection = calendarSelectionFixture({
    version: 3,
    items: [
      entry({ calendarRef: "cal-team", displayName: "Equipo", isPrimary: false, accessRole: "writer", readEnabled: true, writeEnabled: false }),
      entry({}),
      entry({ calendarRef: "cal-holidays", displayName: "<b>Feriados</b>", isPrimary: false, accessRole: "reader", readEnabled: false, writeEnabled: false }),
    ],
  });

  it("lists the primary calendar first with independent read and write toggles", () => {
    render(<CalendarSettings initialStatus={connected} initialSelection={selection} timeZone="Etc/UTC" client={fakeCalendarClient()} />);
    const rows = screen.getAllByRole("group");
    expect(rows[0]?.textContent).toContain("Principal");
    expect(within(rows[0]!).getByText("Principal (calendario principal)")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Leer Equipo" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Proponer cambios en Equipo" }) as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText(/dos pasos/i)).toBeTruthy();
    expect(screen.getByText(/editor o propietario/i)).toBeTruthy();
  });

  it("disables write for a calendar whose provider role cannot write and says why", () => {
    render(<CalendarSettings initialStatus={connected} initialSelection={selection} timeZone="Etc/UTC" client={fakeCalendarClient()} />);
    const write = screen.getByRole("checkbox", { name: "Proponer cambios en <b>Feriados</b>" }) as HTMLInputElement;
    expect(write.disabled).toBe(true);
    expect(document.getElementById(write.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toMatch(/solo lectura en Google/);
  });

  it("requires a saved read selection before write can be enabled", () => {
    render(<CalendarSettings initialStatus={connected} initialSelection={calendarSelectionFixture({ version: 1, items: [entry({}), entry({ calendarRef: "cal-new", displayName: "Proyecto", isPrimary: false, accessRole: "writer", readEnabled: false, writeEnabled: false })] })} timeZone="Etc/UTC" client={fakeCalendarClient()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Leer Proyecto" }));
    const write = screen.getByRole("checkbox", { name: "Proponer cambios en Proyecto" }) as HTMLInputElement;
    expect(write.disabled).toBe(true);
    expect(document.getElementById(write.getAttribute("aria-describedby")!.split(" ")[0]!)?.textContent).toMatch(/Primero guarda la lectura/);
  });

  it("saves read and write flags with the expected version", async () => {
    const updateSelection = vi.fn(async () => calendarSelectionFixture({ version: 4, items: selection.items }));
    render(<CalendarSettings initialStatus={connected} initialSelection={selection} timeZone="Etc/UTC" client={fakeCalendarClient({ updateSelection })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Proponer cambios en Equipo" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar selección" }));
    await screen.findByText("Selección guardada.");
    expect(updateSelection).toHaveBeenCalledWith({
      expectedVersion: 3,
      calendars: [
        { calendarRef: "cal-primary", readEnabled: true, writeEnabled: true },
        { calendarRef: "cal-team", readEnabled: true, writeEnabled: true },
        { calendarRef: "cal-holidays", readEnabled: false, writeEnabled: false },
      ],
    });
  });

  it("reloads the selection after a 409 and never resubmits automatically", async () => {
    const updateSelection = vi.fn(async () => { throw new BffRequestError(409, null); });
    const reloaded = calendarSelectionFixture({ version: 9, items: [entry({ readEnabled: true, writeEnabled: false })] });
    const client = fakeCalendarClient({ updateSelection, selection: vi.fn(async () => reloaded) });
    render(<CalendarSettings initialStatus={connected} initialSelection={selection} timeZone="Etc/UTC" client={client} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Proponer cambios en Equipo" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar selección" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cambió en otro lugar/);
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Leer Equipo" })).toBeNull());
    expect(updateSelection).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("checkbox", { name: "Proponer cambios en Principal" }) as HTMLInputElement).checked).toBe(false);
  });

  it("discovers other calendars only after an explicit request, defaulting them to off", async () => {
    const calendars = vi.fn(async () => calendarSelectionFixture({ version: 3, items: [entry({}), entry({ calendarRef: "cal-other", displayName: "Otro", isPrimary: false, accessRole: "owner", readEnabled: false, writeEnabled: false })] }));
    render(<CalendarSettings initialStatus={connected} initialSelection={calendarSelectionFixture({ version: 3, items: [entry({})] })} timeZone="Etc/UTC" client={fakeCalendarClient({ calendars })} />);
    expect(calendars).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Elegir otros calendarios" }));
    const read = await screen.findByRole("checkbox", { name: "Leer Otro" }) as HTMLInputElement;
    expect(read.checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Proponer cambios en Otro" }) as HTMLInputElement).checked).toBe(false);
  });
});
