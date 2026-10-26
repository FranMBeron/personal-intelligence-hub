// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentFixture, calendarSelectionFixture, calendarStatusFixture, sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import type { SystemSnapshot } from "../_lib/system-view";
import { SystemStatusClient } from "../_lib/system-client";
import { CalendarSettings } from "./calendar-settings";
import { fakeCalendarClient } from "./calendar-test-client";
import { SystemStatusSection } from "./system-status-section";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const healthy: SystemSnapshot = {
  connectors: { state: "loaded", value: { sources: [sourceStatusFixture({ id: "hermes" })] } },
  agents: { state: "loaded", value: [agentFixture({ id: "one" })] },
  calendar: { state: "loaded", value: calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true }) },
};

describe("SystemStatusSection", () => {
  it("does not show the success mark when Hermes is unavailable", () => {
    render(<SystemStatusSection initial={{ ...healthy, connectors: { state: "loaded", value: { sources: [sourceStatusFixture({ id: "hermes", state: "unavailable" })] } } }} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" />);
    const section = screen.getByRole("region", { name: /Estado del sistema/ });
    expect(section.querySelector(".system-status__icon")?.textContent).not.toBe("✓");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Hay servicios sin respuesta");
  });

  it("shows the success mark only when every source was verified", () => {
    render(<SystemStatusSection initial={healthy} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Servicios verificados");
    expect(document.querySelector(".system-status__icon")?.textContent).toBe("✓");
  });

  it("renders absent host telemetry as not measured instead of zero", () => {
    render(<SystemStatusSection initial={healthy} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" />);
    const telemetry = screen.getByRole("list", { name: "Telemetría del servidor" });
    expect(telemetry.textContent).toContain("No medido");
    expect(telemetry.textContent).not.toMatch(/\b0\s?%/);
  });

  it("refreshes on demand with one pending request and the disabled control announced", async () => {
    let release: (value: SystemSnapshot) => void = () => undefined;
    const load = vi.fn(() => new Promise<SystemSnapshot>((resolve) => { release = resolve; }));
    render(<SystemStatusSection initial={healthy} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" client={{ load }} />);
    const button = screen.getByRole("button", { name: "Actualizar estado" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(load).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Comprobando…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release({ ...healthy, calendar: { state: "loaded", value: calendarStatusFixture({ state: "requires_reauthorization" }) } }));
    await screen.findByText("Requiere volver a autorizar");
    expect((screen.getByRole("button", { name: "Actualizar estado" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops showing Calendar as connected once it is disconnected in Sistema", async () => {
    const disconnect = vi.fn(async () => sourceStatusFixture({ id: "calendar", state: "not_configured", lastSuccessAt: undefined }));
    render(
      <>
        <SystemStatusSection initial={healthy} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" client={{ load: vi.fn() }} />
        <CalendarSettings initialStatus={healthy.calendar.state === "loaded" ? healthy.calendar.value : calendarStatusFixture()} initialSelection={calendarSelectionFixture()} timeZone="Etc/UTC" client={fakeCalendarClient({ disconnect })} />
      </>,
    );
    const card = screen.getByRole("article", { name: "Google Calendar" });
    expect(card.textContent).toContain("Disponible");
    fireEvent.click(screen.getByRole("button", { name: "Desconectar Google Calendar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar desconexión" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "Google Calendar" }).textContent).not.toContain("Disponible"));
    expect(screen.getByRole("heading", { level: 2 }).textContent).not.toBe("Servicios verificados");
  });

  it("keeps a configured-absent source as not configured when a refresh cannot reach it", async () => {
    const initial: SystemSnapshot = { ...healthy, calendar: { state: "not_configured" } };
    const load = vi.fn(async () => ({ ...healthy, calendar: { state: "unavailable" as const } }));
    render(<SystemStatusSection initial={initial} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" client={{ load }} />);
    fireEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Actualizar estado" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("article", { name: "Google Calendar" }).textContent).toContain("No configurado");
  });

  it("keeps the last data and says so when a refresh fails entirely", async () => {
    const load = vi.fn(async () => { throw new Error("offline"); });
    render(<SystemStatusSection initial={healthy} now="2026-10-12T12:00:00.000Z" timeZone="Etc/UTC" client={{ load }} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar estado" }));
    await waitFor(() => expect(alert.textContent).toMatch(/No se pudo actualizar/));
    expect(screen.getByRole("article", { name: "Hermes" })).toBeTruthy();
  });
});

describe("SystemStatusClient", () => {
  it("loads each source independently and maps failures to unavailable", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/ui/v1/system/status") return Response.json({ sources: [sourceStatusFixture({ id: "hermes" })] });
      if (path === "/api/ui/v1/agents") return new Response(null, { status: 503 });
      if (path === "/api/ui/v1/calendar/status") return Response.json(calendarStatusFixture());
      throw new Error(`Unexpected ${path}`);
    });
    const snapshot = await new SystemStatusClient(fetcher).load();
    expect(snapshot.connectors.state).toBe("loaded");
    expect(snapshot.agents.state).toBe("unavailable");
    expect(snapshot.calendar.state).toBe("loaded");
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET")).toBe(true);
  });

  it("tells a Calendar that is not configured apart from one that is failing", async () => {
    const calendarStatus = (status: number) => vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/ui/v1/calendar/status") {
        return Response.json({ type: "about:blank", title: "Calendar", status, detail: "Calendar.", instance: path, code: "dependency_unavailable", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957" }, { status });
      }
      return new Response(null, { status: 503 });
    });
    expect((await new SystemStatusClient(calendarStatus(501)).load()).calendar.state).toBe("not_configured");
    expect((await new SystemStatusClient(calendarStatus(503)).load()).calendar.state).toBe("unavailable");
  });

  it("rejects malformed bodies instead of trusting them", async () => {
    const fetcher = vi.fn(async () => Response.json({ sources: [{ id: "x", state: "great" }] }));
    const snapshot = await new SystemStatusClient(fetcher).load();
    expect(snapshot.connectors.state).toBe("unavailable");
  });
});
