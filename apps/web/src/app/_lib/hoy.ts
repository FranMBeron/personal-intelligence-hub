import type { Snapshot, Task, TaskPriority } from "@personal-intelligence-hub/contracts";

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
  dateLabel: string;
  greeting: string;
  priorities: readonly Task[];
  activePriorityCount: number;
  generatedAt: string;
}>;

export const buildHoyView = (snapshot: Snapshot, now: Date): HoyView => {
  const priorities = snapshot.tasks
    .filter((task) => task.archivedAt === null)
    .toSorted(
      (left, right) =>
        completedRank(left) - completedRank(right) ||
        priorityRank[left.priority] - priorityRank[right.priority] ||
        dueTime(left) - dueTime(right) ||
        left.id.localeCompare(right.id),
    );
  const hour = now.getHours();
  const greeting = hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";

  return {
    dateLabel: new Intl.DateTimeFormat("es-ES", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now),
    greeting,
    priorities,
    activePriorityCount: priorities.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ).length,
    generatedAt: snapshot.generatedAt,
  };
};
