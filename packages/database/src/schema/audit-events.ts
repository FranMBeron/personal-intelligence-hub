import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { actors, actorTypeValues } from "./actors.js";
import { mutationMethodValues } from "./idempotency.js";

export const mutationSourceValues = [
  "pih",
  "telegram",
  "hermes-web",
  "automation",
  "test",
] as const;
export const aggregateTypeValues = ["board", "column", "card", "tag", "relation", "task"] as const;

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    principalSubject: text("principal_subject").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    actorType: text("actor_type", { enum: actorTypeValues }).notNull(),
    source: text("source", { enum: mutationSourceValues }).notNull(),
    requestId: uuid("request_id").notNull(),
    routeTemplate: text("route_template").notNull(),
    method: text("method", { enum: mutationMethodValues }).notNull(),
    entityType: text("entity_type", { enum: aggregateTypeValues }).notNull(),
    entityId: uuid("entity_id").notNull(),
    entityVersion: integer("entity_version").notNull(),
    eventType: text("event_type").notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown> | null>(),
    afterState: jsonb("after_state").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    compensatesEventId: uuid("compensates_event_id").references(
      (): AnyPgColumn => auditEvents.id,
      { onDelete: "restrict" },
    ),
  },
  (table) => [
    check("audit_events_subject_nonempty", sql`length(${table.principalSubject}) > 0`),
    check("audit_events_actor_type_check", sql`${table.actorType} IN ('human', 'agent', 'service')`),
    check("audit_events_source_check", sql`${table.source} IN ('pih', 'telegram', 'hermes-web', 'automation', 'test')`),
    check("audit_events_method_check", sql`${table.method} IN ('POST', 'PUT', 'PATCH', 'DELETE')`),
    check("audit_events_route_check", sql`${table.routeTemplate} LIKE '/v1/%'`),
    check("audit_events_entity_type_check", sql`${table.entityType} IN ('board', 'column', 'card', 'tag', 'relation', 'task')`),
    check("audit_events_entity_version_check", sql`${table.entityVersion} >= 1`),
    check("audit_events_event_type_nonempty", sql`length(${table.eventType}) > 0`),
    check("audit_events_state_check", sql`${table.beforeState} IS NOT NULL OR ${table.afterState} IS NOT NULL`),
    unique("audit_events_aggregate_version_unique").on(
      table.entityType,
      table.entityId,
      table.entityVersion,
    ),
    index("audit_events_occurred_at_id_idx").on(table.occurredAt.desc(), table.id.desc()),
    index("audit_events_actor_id_idx").on(table.actorId),
    index("audit_events_compensates_event_id_idx").on(table.compensatesEventId),
  ],
);
