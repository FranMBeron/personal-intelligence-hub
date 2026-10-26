// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agendaFixture, calendarStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { AgendaPanel, toAgendaResult } from "./agenda";

afterEach(cleanup);

const now = "2026-10-12T12:30:00.000Z";
const event = (eventRef: string, title: string, start: string, end: string, location?: string) => ({
  eventRef, calendarRef: "cal-a", calendarDisplayName: "Trabajo", title,
  time: { kind: "timed" as const, start, end, timeZone: "Etc/UTC" }, status: "confirmed" as const,
  ...(location === undefined ? {} : { location }),
});

describe("AgendaPanel", () => {
  it("shows the next event from real calendar data with its own freshness", () => {
    const agenda = agendaFixture({ generatedAt: "2026-10-12T12:20:00.000Z", items: [event("e1", "Revisión", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z", "Sala 2")] });
    render(<AgendaPanel result={{ state: "available", agenda }} now={now} timeZone="Etc/UTC" />);
    const panel = screen.getByRole("region", { name: "Agenda de hoy" });
    expect(panel.textContent).toContain("Siguiente");
    expect(screen.getByRole("list", { name: "Eventos de hoy" }).textContent).toContain("Revisión");
    expect(panel.textContent).toContain("Sala 2");
    const freshness = screen.getByText(/Agenda actualizada/);
    expect(freshness.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-12T12:20:00.000Z");
  });

  it("marks the ongoing event as now", () => {
    const agenda = agendaFixture({ items: [event("e1", "En curso", "2026-10-12T12:00:00.000Z", "2026-10-12T13:00:00.000Z")] });
    render(<AgendaPanel result={{ state: "available", agenda }} now={now} timeZone="Etc/UTC" />);
    expect(screen.getByText("Ahora").closest("[data-phase]")?.getAttribute("data-phase")).toBe("current");
  });

  it("renders provider titles and locations as inert plain text", () => {
    const agenda = agendaFixture({ items: [event("e1", "<script>alert(1)</script>**x**", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z", "<a href='javascript:x'>aquí</a>")] });
    const { container } = render(<AgendaPanel result={{ state: "available", agenda }} now={now} timeZone="Etc/UTC" />);
    expect(container.querySelector("script, a, strong, em")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>**x**");
  });

  it.each([
    [{ state: "available" as const, agenda: agendaFixture() }, "empty", /No hay eventos hoy/],
    [{ state: "unconfigured" as const }, "not_configured", /Calendario no configurado/],
    [{ state: "unavailable" as const }, "unavailable", /Agenda no disponible/],
    [{ state: "reauthorization" as const }, "requires_reauthorization", /volver a autorizar/i],
    [{ state: "permission_denied" as const }, "error", /permiso/i],
  ])("renders %o as its own honest state", (result, dataState, copy) => {
    render(<AgendaPanel result={result} now={now} timeZone="Etc/UTC" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-state")).toBe(dataState);
    expect(status.textContent).toMatch(copy);
    expect(screen.queryByRole("list", { name: "Eventos de hoy" })).toBeNull();
  });

  it("does not claim an empty day when the agenda window misses the user's day", () => {
    const agenda = agendaFixture({ from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" });
    render(<AgendaPanel result={{ state: "available", agenda }} now={now} timeZone="Europe/Madrid" />);
    expect(screen.getByRole("status").getAttribute("data-state")).toBe("unavailable");
    expect(screen.queryByText(/No hay eventos hoy/)).toBeNull();
  });

  it("dates a stale agenda read on a previous local day instead of showing a bare clock", () => {
    const agenda = agendaFixture({ generatedAt: "2026-10-11T09:00:00.000Z", items: [event("e1", "Viejo", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z")] });
    render(<AgendaPanel result={{ state: "stale", agenda }} now={now} timeZone="Etc/UTC" />);
    expect(screen.getByText(/Última agenda leída/).querySelector("time")?.textContent).toMatch(/11/);
  });

  it("renders the same event visible from two calendars as two rows", () => {
    const shared = event("same-ref", "Compartido", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z");
    const agenda = agendaFixture({ items: [shared, { ...shared, calendarRef: "cal-b", calendarDisplayName: "Equipo" }] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<AgendaPanel result={{ state: "available", agenda }} now={now} timeZone="Etc/UTC" />);
    expect(screen.getByRole("list", { name: "Eventos de hoy" }).querySelectorAll("li")).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("asks for attention when the calendar selection is incomplete", () => {
    render(<AgendaPanel result={{ state: "attention" }} now={now} timeZone="Etc/UTC" />);
    expect(screen.getByRole("status").getAttribute("data-state")).toBe("requires_attention");
  });

  it("keeps stale events visible but labelled stale with the last success time", () => {
    const agenda = agendaFixture({ generatedAt: "2026-10-12T09:00:00.000Z", items: [event("e1", "Viejo", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z")] });
    render(<AgendaPanel result={{ state: "stale", agenda }} now={now} timeZone="Etc/UTC" />);
    expect(screen.getByRole("status").textContent).toMatch(/Datos sin actualizar/);
    expect(screen.getByRole("list", { name: "Eventos de hoy" }).textContent).toContain("Viejo");
  });
});

describe("toAgendaResult", () => {
  const agenda = { state: "loaded" as const, value: agendaFixture() };
  it("maps calendar status to distinct agenda states", () => {
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "not_configured" }) }, agenda).state).toBe("unconfigured");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "requires_reauthorization" }) }, agenda).state).toBe("reauthorization");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "degraded", safeReasonCode: "provider_permission_denied" }) }, agenda).state).toBe("permission_denied");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "available", stale: true }) }, agenda).state).toBe("stale");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "available" }) }, agenda).state).toBe("available");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "available" }) }, { state: "unavailable" }).state).toBe("unavailable");
    expect(toAgendaResult({ state: "unavailable" }, { state: "unavailable" }).state).toBe("unavailable");
    expect(toAgendaResult({ state: "not_configured" }, { state: "not_configured" }).state).toBe("unconfigured");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "requires_attention", safeReasonCode: "calendar_selection_required" }) }, agenda).state).toBe("attention");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "degraded", safeReasonCode: "provider_temporarily_unavailable" }) }, agenda).state).toBe("stale");
    expect(toAgendaResult({ state: "loaded", value: calendarStatusFixture({ state: "unavailable" }) }, { state: "unavailable" }).state).toBe("unavailable");
  });
});
