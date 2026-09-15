import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { cards } from "./cards.js";

export const taskStatusValues = ["todo", "in_progress", "done", "cancelled"] as const;
export const taskPriorityValues = ["low", "normal", "high", "critical"] as const;

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: taskStatusValues }).default("todo").notNull(),
    priority: text("priority", { enum: taskPriorityValues }).default("normal").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cardId: uuid("card_id").references(() => cards.id, { onDelete: "set null" }),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("tasks_title_nonempty", sql`length(btrim(${table.title})) > 0`),
    check("tasks_status_check", sql`${table.status} IN ('todo', 'in_progress', 'done', 'cancelled')`),
    check("tasks_priority_check", sql`${table.priority} IN ('low', 'normal', 'high', 'critical')`),
    check("tasks_dates_check", sql`${table.startsAt} IS NULL OR ${table.dueAt} IS NULL OR ${table.startsAt} <= ${table.dueAt}`),
    check("tasks_version_check", sql`${table.version} >= 1`),
    index("tasks_updated_at_id_idx").on(table.updatedAt.desc(), table.id.desc()),
    index("tasks_card_id_idx").on(table.cardId),
  ],
);
