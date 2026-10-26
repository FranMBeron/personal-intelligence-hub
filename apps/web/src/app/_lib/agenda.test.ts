import { describe, expect, it } from "vitest";

import type { CalendarAgendaItem } from "@personal-intelligence-hub/contracts";
import { agendaFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { agendaRequestWindow, buildAgendaView, localDayBounds, localDayKey } from "./agenda";

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

const timed = (eventRef: string, start: string, end: string, overrides: Partial<CalendarAgendaItem> = {}): CalendarAgendaItem => ({
  eventRef, calendarRef: "cal-a", calendarDisplayName: "Trabajo", title: `Evento ${eventRef}`,
  time: { kind: "timed", start, end, timeZone: "Etc/UTC" }, status: "confirmed", ...overrides,
});
const allDay = (eventRef: string, startDate: string, endDateExclusive: string): CalendarAgendaItem => ({
  eventRef, calendarRef: "cal-a", calendarDisplayName: "Trabajo", title: `Todo el día ${eventRef}`,
  time: { kind: "all_day", startDate, endDateExclusive }, status: "confirmed",
});

describe("local day projection", () => {
  it("derives the day key in the user's zone", () => {
    const instant = new Date("2026-10-12T01:00:00Z");
    expect(localDayKey(instant, "America/Argentina/Buenos_Aires")).toBe("2026-10-11");
    expect(localDayKey(instant, "Etc/UTC")).toBe("2026-10-12");
    expect(localDayKey(instant, "Pacific/Kiritimati")).toBe("2026-10-12");
  });

  it("covers a 23-hour spring-forward day and a 25-hour fall-back day", () => {
    const spring = localDayBounds("2026-03-29", "Europe/Madrid");
    expect(spring).toEqual({ from: "2026-03-28T23:00:00.000Z", to: "2026-03-29T22:00:00.000Z" });
    expect(hours(spring.from, spring.to)).toBe(23);
    const fall = localDayBounds("2026-10-25", "Europe/Madrid");
    expect(fall).toEqual({ from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z" });
    expect(hours(fall.from, fall.to)).toBe(25);
    expect(hours(...Object.values(localDayBounds("2026-03-08", "America/New_York")) as [string, string])).toBe(23);
    expect(hours(...Object.values(localDayBounds("2026-11-01", "America/New_York")) as [string, string])).toBe(25);
  });

  it("starts the day at the first existing instant when local midnight is skipped", () => {
    // Santiago skips 00:00-01:00 on its September spring-forward day.
    const bounds = localDayBounds("2026-09-06", "America/Santiago");
    expect(localDayKey(new Date(bounds.from), "America/Santiago")).toBe("2026-09-06");
    expect(localDayKey(new Date(Date.parse(bounds.from) - 1), "America/Santiago")).toBe("2026-09-05");
    expect(localDayKey(new Date(Date.parse(bounds.to) - 1), "America/Santiago")).toBe("2026-09-06");
    expect(localDayKey(new Date(bounds.to), "America/Santiago")).toBe("2026-09-07");
  });

  it("requests a UTC window that contains the full local day", () => {
    expect(agendaRequestWindow(new Date("2026-10-25T12:00:00Z"), "Europe/Madrid")).toEqual({
      from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z", timeZone: "Europe/Madrid",
    });
  });
});

describe("buildAgendaView", () => {
  const now = new Date("2026-10-12T12:30:00Z");

  it("puts the ongoing event first as current and the next future event as next", () => {
    const agenda = agendaFixture({ items: [
      timed("later", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z"),
      timed("ongoing", "2026-10-12T12:00:00.000Z", "2026-10-12T13:00:00.000Z"),
      timed("done", "2026-10-12T08:00:00.000Z", "2026-10-12T09:00:00.000Z"),
      timed("soon", "2026-10-12T14:00:00.000Z", "2026-10-12T14:30:00.000Z"),
    ] });
    const view = buildAgendaView(agenda, now, "Etc/UTC");
    expect(view.current?.eventRef).toBe("ongoing");
    expect(view.next?.eventRef).toBe("soon");
    expect(view.timed.map((row) => [row.eventRef, row.phase])).toEqual([
      ["done", "past"], ["ongoing", "current"], ["soon", "upcoming"], ["later", "upcoming"],
    ]);
    expect(view.timed[1]?.timeLabel).toBe("12:00 – 13:00");
  });

  it("keeps all-day events on their calendar dates and excludes the exclusive end date", () => {
    const agenda = agendaFixture({ items: [allDay("single", "2026-10-12", "2026-10-13"), allDay("ended", "2026-10-11", "2026-10-12")] });
    expect(buildAgendaView(agenda, now, "Etc/UTC").allDay.map((row) => row.eventRef)).toEqual(["single"]);
    const tomorrow = buildAgendaView(agenda, new Date("2026-10-13T10:00:00Z"), "Etc/UTC");
    expect(tomorrow.allDay).toEqual([]);
    // An all-day date is not an instant: far-west and far-east zones see the same date.
    expect(buildAgendaView(agenda, new Date("2026-10-12T20:00:00Z"), "Pacific/Honolulu").allDay.map((row) => row.eventRef)).toEqual(["single"]);
    expect(buildAgendaView(agenda, new Date("2026-10-12T02:00:00Z"), "Pacific/Kiritimati").allDay.map((row) => row.eventRef)).toEqual(["single"]);
  });

  it("does not let all-day events become current or next", () => {
    const view = buildAgendaView(agendaFixture({ items: [allDay("a", "2026-10-12", "2026-10-13")] }), now, "Etc/UTC");
    expect(view.current).toBeNull();
    expect(view.next).toBeNull();
    expect(view.isEmpty).toBe(false);
  });

  it("drops cancelled events defensively", () => {
    const cancelled = { ...timed("gone", "2026-10-12T14:00:00.000Z", "2026-10-12T15:00:00.000Z"), status: "cancelled" } as unknown as CalendarAgendaItem;
    const view = buildAgendaView({ ...agendaFixture(), items: [cancelled] }, now, "Etc/UTC");
    expect(view.timed).toEqual([]);
    expect(view.isEmpty).toBe(true);
  });

  it("projects onto the local day of the user's zone, including events crossing midnight", () => {
    const items = [
      timed("late", "2026-10-12T23:30:00.000Z", "2026-10-13T01:00:00.000Z"),
      timed("morning-tokyo", "2026-10-12T23:00:00.000Z", "2026-10-12T23:30:00.000Z"),
    ];
    const agenda = agendaFixture({ from: "2026-10-12T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", items });
    const utc = buildAgendaView(agenda, now, "Etc/UTC");
    expect(utc.timed.map((row) => row.eventRef)).toEqual(["morning-tokyo", "late"]);
    expect(utc.timed.find((row) => row.eventRef === "late")?.timeLabel).toBe("23:30 – continúa mañana");
    const tokyo = buildAgendaView(agenda, new Date("2026-10-13T00:30:00Z"), "Asia/Tokyo");
    expect(tokyo.dayKey).toBe("2026-10-13");
    expect(tokyo.timed.find((row) => row.eventRef === "morning-tokyo")?.timeLabel).toBe("08:00 – 08:30");
  });

  it("labels an event that started the previous day", () => {
    const agenda = agendaFixture({ items: [timed("overnight", "2026-10-11T22:00:00.000Z", "2026-10-12T02:00:00.000Z")] });
    expect(buildAgendaView(agenda, now, "Etc/UTC").timed[0]?.timeLabel).toBe("Desde ayer – 02:00");
  });

  it("reports the agenda's own generation time as its freshness", () => {
    const view = buildAgendaView(agendaFixture({ generatedAt: "2026-10-12T12:20:00.000Z" }), now, "Etc/UTC");
    expect(view.generatedAt).toBe("2026-10-12T12:20:00.000Z");
    expect(view.isEmpty).toBe(true);
  });

  it("labels timed events correctly on a 25-hour fall-back day", () => {
    // Europe/Madrid 2026-10-25: 02:00-03:00 local happens twice (CEST then CET).
    const agenda = agendaFixture({ timeZone: "Europe/Madrid", from: "2026-10-24T22:00:00.000Z", to: "2026-10-25T23:00:00.000Z", items: [
      timed("first-pass", "2026-10-25T00:30:00.000Z", "2026-10-25T00:45:00.000Z"),
      timed("second-pass", "2026-10-25T01:30:00.000Z", "2026-10-25T01:45:00.000Z"),
      timed("last-hour", "2026-10-25T22:00:00.000Z", "2026-10-25T22:59:00.000Z"),
    ] });
    const view = buildAgendaView(agenda, new Date("2026-10-25T12:00:00Z"), "Europe/Madrid");
    expect(view.timed.map((row) => row.timeLabel)).toEqual(["02:30 – 02:45", "02:30 – 02:45", "23:00 – 23:59"]);
    expect(view.coversDay).toBe(true);
  });

  it("keeps a late event on a 23-hour spring-forward day and drops the next day's first event", () => {
    const agenda = agendaFixture({ timeZone: "Europe/Madrid", from: "2026-03-28T23:00:00.000Z", to: "2026-03-29T23:00:00.000Z", items: [
      timed("late", "2026-03-29T21:30:00.000Z", "2026-03-29T21:59:00.000Z"),
      timed("tomorrow", "2026-03-29T22:00:00.000Z", "2026-03-29T22:30:00.000Z"),
    ] });
    const view = buildAgendaView(agenda, new Date("2026-03-29T10:00:00Z"), "Europe/Madrid");
    expect(view.timed.map((row) => [row.eventRef, row.timeLabel])).toEqual([["late", "23:30 – 23:59"]]);
  });

  it("flags an agenda window that does not cover the user's local day", () => {
    const agenda = agendaFixture({ from: "2026-10-12T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" });
    expect(buildAgendaView(agenda, new Date("2026-10-12T12:00:00Z"), "Etc/UTC").coversDay).toBe(true);
    expect(buildAgendaView(agenda, new Date("2026-10-12T12:00:00Z"), "Europe/Madrid").coversDay).toBe(false);
  });

  it("orders simultaneous events deterministically", () => {
    const agenda = agendaFixture({ items: [
      timed("b", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z", { title: "Igual" }),
      timed("a", "2026-10-12T15:00:00.000Z", "2026-10-12T16:00:00.000Z", { title: "Igual" }),
    ] });
    expect(buildAgendaView(agenda, now, "Etc/UTC").timed.map((row) => row.eventRef)).toEqual(["a", "b"]);
  });
});
