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

import { cards } from "./cards.js";

export const relationTypeValues = [
  "related",
  "supports",
  "blocks",
  "duplicates",
  "references",
] as const;

export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey(),
    fromCardId: uuid("from_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "restrict" }),
    toCardId: uuid("to_card_id")
      .notNull()
      .references(() => cards.id, { onDelete: "restrict" }),
    relationType: text("relation_type", { enum: relationTypeValues }).notNull(),
    version: integer("version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("relations_distinct_cards_check", sql`${table.fromCardId} <> ${table.toCardId}`),
    check(
      "relations_type_check",
      sql`${table.relationType} IN ('related', 'supports', 'blocks', 'duplicates', 'references')`,
    ),
    check("relations_version_check", sql`${table.version} >= 1`),
    unique("relations_directed_identity_unique").on(
      table.fromCardId,
      table.toCardId,
      table.relationType,
    ),
    index("relations_from_card_id_idx").on(table.fromCardId),
    index("relations_to_card_id_idx").on(table.toCardId),
  ],
);
