import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("boards_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("boards_version_check", sql`${table.version} >= 1`),
    index("boards_updated_at_id_idx").on(table.updatedAt.desc(), table.id.desc()),
  ],
);

export const boardColumns = pgTable(
  "board_columns",
  {
    id: uuid("id").primaryKey(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("board_columns_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("board_columns_position_check", sql`${table.position} >= 1`),
    check("board_columns_version_check", sql`${table.version} >= 1`),
    unique("board_columns_board_position_unique").on(table.boardId, table.position),
    unique("board_columns_board_id_id_unique").on(table.boardId, table.id),
    index("board_columns_board_position_idx").on(table.boardId, table.position),
  ],
);
