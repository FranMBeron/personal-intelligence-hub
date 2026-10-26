// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Snapshot, Task } from "@personal-intelligence-hub/contracts";
import { agendaFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { HoyOperationalSection } from "./hoy-operational-section";

afterEach(cleanup);

const now = "2026-10-12T12:30:00.000Z";
const task: Task = {
  id: "10000000-0000-4000-8000-000000000001", title: "Preparar informe", description: null, status: "todo", priority: "high",
  dueAt: null, startsAt: null, completedAt: null, cardId: null, version: 1, archivedAt: null,
  createdAt: "2026-10-12T08:00:00.000Z", updatedAt: "2026-10-12T08:00:00.000Z",
};
const snapshot: Snapshot = { generatedAt: "2026-10-12T12:25:00.000Z", lastSequence: "0", boards: [], cards: [], relations: [], tasks: [task] };
const agenda = agendaFixture({ generatedAt: "2026-10-12T11:00:00.000Z", items: [{
  eventRef: "e1", calendarRef: "c", calendarDisplayName: "Trabajo", title: "Revisión",
  time: { kind: "timed", start: "2026-10-12T15:00:00.000Z", end: "2026-10-12T16:00:00.000Z", timeZone: "Etc/UTC" }, status: "confirmed",
}] });

describe("HoyOperationalSection", () => {
  it("shows priorities even when the calendar fails", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "unavailable" }} timeZone={{ state: "loaded", value: "Etc/UTC" }} now={now} />);
    expect(screen.getByRole("list", { name: "Prioridades de hoy" }).textContent).toContain("Preparar informe");
    expect(within(screen.getByRole("region", { name: "Agenda de hoy" })).getByRole("status").textContent).toMatch(/Agenda no disponible/);
  });

  it("shows the agenda even when tasks fail", () => {
    render(<HoyOperationalSection priorities={{ state: "unavailable" }} agenda={{ state: "available", agenda }} timeZone={{ state: "loaded", value: "Etc/UTC" }} now={now} />);
    expect(screen.getByRole("list", { name: "Eventos de hoy" }).textContent).toContain("Revisión");
    expect(within(screen.getByRole("region", { name: "Prioridades de hoy" })).getByRole("status").textContent).toMatch(/Prioridades no disponibles/);
  });

  it("addresses the user with tú, like the rest of the app", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "unconfigured" }} timeZone={{ state: "loaded", value: "Etc/UTC" }} now={now} />);
    expect(screen.getByText("Tienes 1 prioridad activa para hoy.")).toBeTruthy();
    expect(screen.getByText(/Conecta un calendario en Sistema/)).toBeTruthy();
  });

  it("never lets task freshness label the agenda as updated", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "unavailable" }} timeZone={{ state: "loaded", value: "Etc/UTC" }} now={now} />);
    const agendaRegion = screen.getByRole("region", { name: "Agenda de hoy" });
    expect(agendaRegion.textContent).not.toMatch(/actualizad/i);
    expect(agendaRegion.querySelector(`time[datetime="${snapshot.generatedAt}"]`)).toBeNull();
    const priorities = screen.getByRole("region", { name: "Prioridades de hoy" });
    expect(priorities.querySelector("time")?.getAttribute("dateTime")).toBe(snapshot.generatedAt);
  });

  it("uses the preference zone for the day heading", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "unconfigured" }} timeZone={{ state: "loaded", value: "Pacific/Kiritimati" }} now="2026-10-12T12:30:00.000Z" />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Buenas noches");
    expect(screen.getByText(/martes|13/).textContent).toMatch(/13/);
  });

  it("states an explicit configured fallback zone instead of using the machine zone", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "available", agenda }} timeZone={{ state: "fallback", value: "Europe/Madrid" }} now={now} />);
    expect(screen.getByText(/zona horaria de la instalación \(Europe\/Madrid\)/)).toBeTruthy();
  });

  it("does not guess a day when the time-zone preference is unavailable", () => {
    render(<HoyOperationalSection priorities={{ state: "loaded", value: snapshot }} agenda={{ state: "available", agenda }} timeZone={{ state: "unavailable" }} now={now} />);
    expect(screen.getByText(/No se pudo leer tu zona horaria/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Eventos de hoy" })).toBeNull();
    expect(screen.getByRole("list", { name: "Prioridades de hoy" }).textContent).toContain("Preparar informe");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Tu día, en contexto");
  });
});
