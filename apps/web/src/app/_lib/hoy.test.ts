import type { Snapshot, Task } from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import { buildHoyView } from "./hoy";

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
});
