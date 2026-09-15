import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { cards } from "./cards.js";

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("tags_name_nonempty", sql`length(btrim(${table.name})) > 0`),
    check("tags_color_check", sql`${table.color} IS NULL OR ${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
    unique("tags_name_unique").on(table.name),
    index("tags_updated_at_id_idx").on(table.updatedAt.desc(), table.id.desc()),
  ],
);

export const cardTags = pgTable(
  "card_tags",
  {
    cardId: uuid("card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.tagId], name: "card_tags_pk" }),
    index("card_tags_tag_id_idx").on(table.tagId),
  ],
);
