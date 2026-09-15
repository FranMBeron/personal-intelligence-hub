import { sql } from "drizzle-orm";
import {
  bigint,
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

import { aggregateTypeValues } from "./audit-events.js";

export const outboxEvents = pgTable(
  "outbox_events",
  {
    sequence: bigint("sequence", { mode: "bigint" })
      .generatedAlwaysAsIdentity({ name: "outbox_events_sequence_seq" })
      .primaryKey(),
    eventId: uuid("event_id").notNull(),
    aggregateType: text("aggregate_type", { enum: aggregateTypeValues }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchAttempts: integer("dispatch_attempts").default(0).notNull(),
    lastDispatchError: text("last_dispatch_error"),
  },
  (table) => [
    unique("outbox_events_event_id_unique").on(table.eventId),
    unique("outbox_events_aggregate_version_unique").on(
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    check("outbox_events_aggregate_type_check", sql`${table.aggregateType} IN ('board', 'column', 'card', 'tag', 'relation', 'task')`),
    check("outbox_events_aggregate_version_check", sql`${table.aggregateVersion} >= 1`),
    check("outbox_events_event_type_nonempty", sql`length(${table.eventType}) > 0`),
    check("outbox_events_dispatch_attempts_check", sql`${table.dispatchAttempts} >= 0`),
    index("outbox_events_dispatch_idx").on(table.dispatchedAt, table.availableAt, table.sequence),
    index("outbox_events_occurred_at_idx").on(table.occurredAt),
  ],
);
