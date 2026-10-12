import { sql } from "drizzle-orm";
import {
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

export const mutationMethodValues = ["POST", "PUT", "PATCH", "DELETE"] as const;
export const idempotencyStateValues = ["processing", "completed"] as const;

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    principalSubject: text("principal_subject").notNull(),
    method: text("method", { enum: mutationMethodValues }).notNull(),
    routeTemplate: text("route_template").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state", { enum: idempotencyStateValues }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("idempotency_records_scope_unique").on(
      table.principalSubject,
      table.method,
      table.routeTemplate,
      table.idempotencyKey,
    ),
    check("idempotency_records_subject_nonempty", sql`length(${table.principalSubject}) > 0`),
    check("idempotency_records_method_check", sql`${table.method} IN ('POST', 'PUT', 'PATCH', 'DELETE')`),
    check("idempotency_records_route_check", sql`${table.routeTemplate} LIKE '/v1/%'`),
    check("idempotency_records_key_check", sql`length(${table.idempotencyKey}) BETWEEN 8 AND 255 AND ${table.idempotencyKey} ~ '^[!-~]+$'`),
    check("idempotency_records_hash_nonempty", sql`length(${table.requestHash}) > 0`),
    check("idempotency_records_state_check", sql`${table.state} IN ('processing', 'completed')`),
    check(
      "idempotency_records_response_check",
      sql`(${table.state} = 'processing' AND ${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL AND ${table.responseHeaders} IS NULL) OR (${table.state} = 'completed' AND ${table.responseStatus} BETWEEN 200 AND 599 AND ${table.responseBody} IS NOT NULL AND ${table.responseHeaders} IS NOT NULL)`,
    ),
    index("idempotency_records_expiry_idx").on(table.expiresAt),
  ],
);
