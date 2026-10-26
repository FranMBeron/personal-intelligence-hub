import type {
  CalendarAgenda,
  CalendarAgendaQuery,
  CalendarSourceStatus,
  Snapshot,
  Task,
  TaskPriority,
  UserPreferences,
} from "@personal-intelligence-hub/contracts";

import type { Loadable } from "../system/_lib/system-view";
import { agendaRequestWindow, toAgendaResult, zonedParts, type AgendaResult } from "./agenda";
import { isValidTimeZone } from "./time-format";

const priorityRank: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const completedRank = (task: Task): number =>
  task.status === "done" || task.status === "cancelled" ? 1 : 0;

const dueTime = (task: Task): number =>
  task.dueAt === null ? Number.POSITIVE_INFINITY : new Date(task.dueAt).getTime();

export type HoyView = Readonly<{
  timeZone: string;
  dateLabel: string;
  greeting: string;
  priorities: readonly Task[];
  activePriorityCount: number;
  generatedAt: string;
}>;

export type DayHeading = Readonly<{ timeZone: string; dateLabel: string; greeting: string }>;

/** Day label and greeting in the user's IANA zone; never the host clock's zone. */
export const buildDayHeading = (now: Date, timeZone: string): DayHeading => {
  const { hour } = zonedParts(now, timeZone);
  const greeting = hour < 6 ? "Buenas noches" : hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  return {
    timeZone,
    dateLabel: new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone }).format(now),
    greeting,
  };
};

/**
 * `timeZone` is the actor's preference. The UTC default exists only so callers that predate the preference keep
 * compiling until the page integration passes it; it is explicit and never the server's local zone.
 */
export const buildHoyView = (snapshot: Snapshot, now: Date, timeZone = "Etc/UTC"): HoyView => {
  const priorities = snapshot.tasks
    .filter((task) => task.archivedAt === null)
    .toSorted(
      (left, right) =>
        completedRank(left) - completedRank(right) ||
        priorityRank[left.priority] - priorityRank[right.priority] ||
        dueTime(left) - dueTime(right) ||
        left.id.localeCompare(right.id),
    );
  return {
    ...buildDayHeading(now, timeZone),
    priorities,
    activePriorityCount: priorities.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ).length,
    generatedAt: snapshot.generatedAt,
  };
};

/** Where the zone used for "today" came from. There is deliberately no machine-zone variant. */
export type TimeZoneResult =
  | Readonly<{ state: "loaded"; value: string }>
  | Readonly<{ state: "fallback"; value: string }>
  | Readonly<{ state: "unavailable" }>;

export type HoyOperationalInputs = Readonly<{
  timeZone: TimeZoneResult;
  priorities: Loadable<Snapshot>;
  agenda: AgendaResult;
}>;

/** Page-neutral data sources; `null` means the source is not configured in this installation. */
export type HoySources = Readonly<{
  preferences: (() => Promise<UserPreferences>) | null;
  /** Explicitly configured installation zone, used only when the user's preference cannot be read. */
  fallbackTimeZone?: string | undefined;
  snapshot: () => Promise<Snapshot>;
  calendarStatus: (() => Promise<CalendarSourceStatus>) | null;
  agenda: ((query: CalendarAgendaQuery) => Promise<CalendarAgenda>) | null;
}>;

const settle = async <T>(operation: (() => Promise<T>) | null): Promise<Loadable<T>> => {
  if (operation === null) return { state: "not_configured" };
  try {
    return { state: "loaded", value: await operation() };
  } catch {
    return { state: "unavailable" };
  }
};

const resolveTimeZone = async (sources: HoySources): Promise<TimeZoneResult> => {
  const preferences = await settle(sources.preferences);
  if (preferences.state === "loaded" && isValidTimeZone(preferences.value.timeZone)) {
    return { state: "loaded", value: preferences.value.timeZone };
  }
  const fallback = sources.fallbackTimeZone;
  return fallback !== undefined && isValidTimeZone(fallback) ? { state: "fallback", value: fallback } : { state: "unavailable" };
};

/**
 * Loads preferences, tasks and calendar independently; each settles on its own so one failure never hides another.
 * The agenda waits only for the zone, because its UTC window must contain the whole local day (23 or 25 hours on DST days).
 */
export const loadHoyOperational = async (sources: HoySources, now: Date): Promise<HoyOperationalInputs> => {
  const timeZonePromise = resolveTimeZone(sources);
  const prioritiesPromise = settle(sources.snapshot);
  const statusPromise = settle(sources.calendarStatus);
  const agendaPromise = timeZonePromise.then((zone): Promise<Loadable<CalendarAgenda>> => {
    const read = sources.agenda;
    if (read === null) return Promise.resolve({ state: "not_configured" });
    if (zone.state === "unavailable") return Promise.resolve({ state: "unavailable" });
    return settle(() => read(agendaRequestWindow(now, zone.value)));
  });
  const [timeZone, priorities, status, agenda] = await Promise.all([timeZonePromise, prioritiesPromise, statusPromise, agendaPromise]);
  return { timeZone, priorities, agenda: toAgendaResult(status, agenda) };
};
