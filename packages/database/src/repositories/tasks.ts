import type { Task } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

import type { Page, PageQuery } from "./types.js";

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: Task["status"];
  priority: Task["priority"];
  due_at: Date | null;
  starts_at: Date | null;
  completed_at: Date | null;
  card_id: string | null;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const mapTask = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  dueAt: row.due_at?.toISOString() ?? null,
  startsAt: row.starts_at?.toISOString() ?? null,
  completedAt: row.completed_at?.toISOString() ?? null,
  cardId: row.card_id,
  version: row.version,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const getTask = async (client: PoolClient, taskId: string): Promise<Task | null> => {
  const result = await client.query<TaskRow>(
    `SELECT id, title, description, status, priority, due_at, starts_at,
            completed_at, card_id, version, archived_at, created_at, updated_at
     FROM tasks WHERE id = $1`,
    [taskId],
  );
  return result.rows[0] === undefined ? null : mapTask(result.rows[0]);
};

export const listTasks = async (
  client: PoolClient,
  query: PageQuery,
): Promise<Page<Task>> => {
  const cursor = query.cursor?.sort;
  const result = await client.query<TaskRow>(
    `SELECT id, title, description, status, priority, due_at, starts_at,
            completed_at, card_id, version, archived_at, created_at, updated_at
     FROM tasks
     WHERE archived_at IS NULL
       AND ($1::timestamptz IS NULL OR (updated_at, id) < ($1::timestamptz, $2::uuid))
     ORDER BY updated_at DESC, id DESC
     LIMIT $3`,
    [cursor?.value ?? null, cursor?.id ?? null, query.limit + 1],
  );
  const hasNextPage = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(mapTask),
    hasNextPage,
    nextCursor:
      hasNextPage && last !== undefined
        ? {
            version: 1,
            route: "/v1/tasks",
            filterHash: "none",
            sort: { value: last.updated_at.toISOString(), id: last.id },
          }
        : null,
  };
};
