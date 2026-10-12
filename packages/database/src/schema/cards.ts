import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { boardColumns, boards } from "./boards.js";

export const cards = pgTable(
  "cards",
  {
    id: uuid("id").primaryKey(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "restrict" }),
    columnId: uuid("column_id").notNull(),
    originalContent: text("original_content").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    position: integer("position").notNull(),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.boardId, table.columnId],
      foreignColumns: [boardColumns.boardId, boardColumns.id],
      name: "cards_board_column_fk",
    }).onDelete("restrict"),
    check("cards_original_content_nonempty", sql`length(btrim(${table.originalContent})) > 0`),
    check("cards_title_nonempty", sql`length(btrim(${table.title})) > 0`),
    check("cards_position_check", sql`${table.position} >= 1`),
    check("cards_version_check", sql`${table.version} >= 1`),
    unique("cards_column_position_unique").on(table.columnId, table.position),
    index("cards_updated_at_id_idx").on(table.updatedAt.desc(), table.id.desc()),
    index("cards_board_updated_at_id_idx").on(
      table.boardId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
  ],
);
