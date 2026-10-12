import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const actorTypeValues = ["human", "agent", "service"] as const;

export const actors = pgTable(
  "actors",
  {
    id: uuid("id").primaryKey(),
    principalSubject: text("principal_subject").notNull(),
    actorType: text("actor_type", { enum: actorTypeValues }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("actors_principal_subject_unique").on(table.principalSubject),
    check("actors_principal_subject_nonempty", sql`length(${table.principalSubject}) > 0`),
    check("actors_actor_type_check", sql`${table.actorType} IN ('human', 'agent', 'service')`),
    index("actors_updated_at_id_idx").on(table.updatedAt.desc(), table.id.desc()),
  ],
);
