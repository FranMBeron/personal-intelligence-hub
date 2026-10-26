import type { CalendarAgendaQuery, Snapshot, Task } from "@personal-intelligence-hub/contracts";
import { agendaFixture, calendarStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it, vi } from "vitest";

import { BffRequestError } from "./bff-request";
import { buildHoyView, loadHoyOperational } from "./hoy";

const now = new Date("2026-09-18T12:00:00.000Z");
const baseTask: Task = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "Base",
  description: null,
  status: "todo",
  priority: "normal",
  dueAt: null,
  startsAt: null,
  completedAt: null,
  cardId: null,
  version: 1,
  archivedAt: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const snapshot = (tasks: Task[]): Snapshot => ({
  generatedAt: now.toISOString(),
  lastSequence: "0",
  boards: [],
  cards: [],
  relations: [],
  tasks,
});

describe("buildHoyView", () => {
  it("orders incomplete work before done and cancelled work", () => {
    const tasks = [
      { ...baseTask, id: "10000000-0000-4000-8000-000000000003", status: "done" },
      { ...baseTask, id: "10000000-0000-4000-8000-000000000002", status: "cancelled" },
      { ...baseTask, id: "10000000-0000-4000-8000-000000000001", status: "todo" },
      { ...baseTask, id: "10000000-0000-4000-8000-000000000004", status: "in_progress" },
    ] satisfies Task[];

    expect(buildHoyView(snapshot(tasks), now).priorities.map(({ status }) => status)).toEqual([
      "todo",
      "in_progress",
      "cancelled",
      "done",
    ]);
  });

  it("uses priority, due date and stable ID as deterministic tie breakers", () => {
    const tasks = [
      { ...baseTask, id: "10000000-0000-4000-8000-000000000008", priority: "low" },
      { ...baseTask, id: "10000000-0000-4000-8000-000000000007", priority: "normal" },
      { ...baseTask, id: "10000000-0000-4000-8000-000000000006", priority: "high" },
      {
        ...baseTask,
        id: "10000000-0000-4000-8000-000000000005",
        priority: "critical",
        dueAt: "2026-09-20T12:00:00.000Z",
      },
      {
        ...baseTask,
        id: "10000000-0000-4000-8000-000000000002",
        priority: "critical",
        dueAt: "2026-09-19T12:00:00.000Z",
      },
      {
        ...baseTask,
        id: "10000000-0000-4000-8000-000000000001",
        priority: "critical",
        dueAt: "2026-09-19T12:00:00.000Z",
      },
    ] satisfies Task[];

    expect(buildHoyView(snapshot(tasks), now).priorities.map(({ id }) => id)).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000005",
      "10000000-0000-4000-8000-000000000006",
      "10000000-0000-4000-8000-000000000007",
      "10000000-0000-4000-8000-000000000008",
    ]);
  });

  it("excludes archived tasks and reports the active priority count", () => {
    const view = buildHoyView(
      snapshot([
        baseTask,
        {
          ...baseTask,
          id: "10000000-0000-4000-8000-000000000002",
          archivedAt: now.toISOString(),
        },
      ]),
      now,
    );
    expect(view.priorities).toHaveLength(1);
    expect(view.activePriorityCount).toBe(1);
  });

  it("uses actor time rather than the process date", () => {
    const instant = new Date("2026-10-12T01:00:00Z");
    const snapshotFixture = snapshot([]);
    const view = buildHoyView(snapshotFixture, instant, "America/Argentina/Buenos_Aires");
    expect(view.dateLabel).toContain("11");
    expect(view.greeting).toBe("Buenas noches");
    const utc = buildHoyView(snapshotFixture, instant, "Etc/UTC");
    expect(utc.dateLabel).toContain("12");
    expect(utc.greeting).toBe("Buenas noches");
  });

  it("produces different days and greetings for the same instant across zones", () => {
    const instant = new Date("2026-10-12T22:30:00Z");
    const tokyo = buildHoyView(snapshot([]), instant, "Asia/Tokyo");
    const losAngeles = buildHoyView(snapshot([]), instant, "America/Los_Angeles");
    expect(tokyo.dateLabel).toContain("13");
    expect(tokyo.greeting).toBe("Buenos días");
    expect(losAngeles.dateLabel).toContain("12");
    expect(losAngeles.greeting).toBe("Buenas tardes");
    expect(tokyo.timeZone).toBe("Asia/Tokyo");
  });

  it("switches greeting at local hour boundaries, not host boundaries", () => {
    expect(buildHoyView(snapshot([]), new Date("2026-10-12T10:59:00Z"), "Europe/Madrid").greeting).toBe("Buenas tardes");
    expect(buildHoyView(snapshot([]), new Date("2026-10-12T09:59:00Z"), "Europe/Madrid").greeting).toBe("Buenos días");
    expect(buildHoyView(snapshot([]), new Date("2026-10-12T18:00:00Z"), "Europe/Madrid").greeting).toBe("Buenas noches");
  });
});

describe("loadHoyOperational", () => {
  const instant = new Date("2026-10-25T12:00:00Z");
  const fail = () => Promise.reject(new Error("upstream detail that must not leak"));
  const available = calendarStatusFixture({ state: "available", canRead: true, primaryCalendarConfigured: true });
  const sources = (overrides: Partial<Parameters<typeof loadHoyOperational>[0]> = {}): Parameters<typeof loadHoyOperational>[0] => ({
    preferences: () => Promise.resolve({ timeZone: "Europe/Madrid", version: 1 }),
    snapshot: () => Promise.resolve(snapshot([])),
    calendarStatus: () => Promise.resolve(available),
    agenda: (query: CalendarAgendaQuery) => Promise.resolve(agendaFixture({ ...query, timeZone: query.timeZone })),
    ...overrides,
  });

  it("requests the agenda for the full local day of the preference zone, including a 25-hour day", async () => {
    const agenda = vi.fn((query: CalendarAgendaQuery) => Promise.resolve(agendaFixture({ ...query })));
    const result = await loadHoyOperational(sources({ agenda }), instant);
    expect(agenda).toHaveBeenCalledWith({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z", timeZone: "Europe/Madrid" });
    expect(result.timeZone).toEqual({ state: "loaded", value: "Europe/Madrid" });
    expect(result.agenda.state).toBe("available");
    expect(result.priorities.state).toBe("loaded");
  });

  it("keeps tasks when the calendar fails and the agenda when tasks fail", async () => {
    const calendarDown = await loadHoyOperational(sources({ agenda: fail, calendarStatus: fail }), instant);
    expect(calendarDown.priorities.state).toBe("loaded");
    expect(calendarDown.agenda.state).toBe("unavailable");
    const tasksDown = await loadHoyOperational(sources({ snapshot: fail }), instant);
    expect(tasksDown.priorities.state).toBe("unavailable");
    expect(tasksDown.agenda.state).toBe("available");
  });

  it("keeps the safe problem code of a failed agenda read", async () => {
    const denied = await loadHoyOperational(sources({ agenda: () => Promise.reject(new BffRequestError(403, "forbidden")) }), instant);
    expect(denied.agenda.state).toBe("permission_denied");
    const conflict = await loadHoyOperational(sources({ agenda: () => Promise.reject(new BffRequestError(409, "conflict")) }), instant);
    expect(conflict.agenda.state).toBe("attention");
    const down = await loadHoyOperational(sources({ agenda: () => Promise.reject(new BffRequestError(503, "dependency_unavailable")) }), instant);
    expect(down.agenda.state).toBe("unavailable");
  });

  it("loads tasks without waiting for the preference", async () => {
    let releasePreferences: () => void = () => undefined;
    const preferences = () => new Promise<{ timeZone: string; version: number }>((resolve) => {
      releasePreferences = () => resolve({ timeZone: "Etc/UTC", version: 1 });
    });
    const snapshotSpy = vi.fn(() => Promise.resolve(snapshot([])));
    const pending = loadHoyOperational(sources({ preferences, snapshot: snapshotSpy }), instant);
    await Promise.resolve();
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    releasePreferences();
    expect((await pending).timeZone).toEqual({ state: "loaded", value: "Etc/UTC" });
  });

  it("uses only an explicit configured fallback when preferences fail, never the machine zone", async () => {
    const withFallback = await loadHoyOperational(sources({ preferences: fail, fallbackTimeZone: "America/New_York" }), instant);
    expect(withFallback.timeZone).toEqual({ state: "fallback", value: "America/New_York" });
    const agenda = vi.fn(() => Promise.resolve(agendaFixture()));
    const without = await loadHoyOperational(sources({ preferences: null, agenda }), instant);
    expect(without.timeZone).toEqual({ state: "unavailable" });
    expect(agenda).not.toHaveBeenCalled();
    const invalid = await loadHoyOperational(sources({ preferences: fail, fallbackTimeZone: "Not/AZone" }), instant);
    expect(invalid.timeZone).toEqual({ state: "unavailable" });
  });

  it("reports an unconfigured calendar without requesting an agenda", async () => {
    const agenda = vi.fn(() => Promise.resolve(agendaFixture()));
    expect((await loadHoyOperational(sources({ calendarStatus: null, agenda: null }), instant)).agenda.state).toBe("unconfigured");
    const notConfigured = await loadHoyOperational(sources({ calendarStatus: () => Promise.resolve(calendarStatusFixture()), agenda }), instant);
    expect(notConfigured.agenda.state).toBe("unconfigured");
  });
});
