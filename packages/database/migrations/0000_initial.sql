CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_subject" text NOT NULL,
	"actor_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actors_principal_subject_unique" UNIQUE("principal_subject"),
	CONSTRAINT "actors_principal_subject_nonempty" CHECK (length("actors"."principal_subject") > 0),
	CONSTRAINT "actors_actor_type_check" CHECK ("actors"."actor_type" IN ('human', 'agent', 'service'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_subject" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"source" text NOT NULL,
	"request_id" uuid NOT NULL,
	"route_template" text NOT NULL,
	"method" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version" integer NOT NULL,
	"event_type" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"compensates_event_id" uuid,
	CONSTRAINT "audit_events_aggregate_version_unique" UNIQUE("entity_type","entity_id","entity_version"),
	CONSTRAINT "audit_events_subject_nonempty" CHECK (length("audit_events"."principal_subject") > 0),
	CONSTRAINT "audit_events_actor_type_check" CHECK ("audit_events"."actor_type" IN ('human', 'agent', 'service')),
	CONSTRAINT "audit_events_source_check" CHECK ("audit_events"."source" IN ('pih', 'telegram', 'hermes-web', 'automation', 'test')),
	CONSTRAINT "audit_events_method_check" CHECK ("audit_events"."method" IN ('POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "audit_events_route_check" CHECK ("audit_events"."route_template" LIKE '/v1/%'),
	CONSTRAINT "audit_events_entity_type_check" CHECK ("audit_events"."entity_type" IN ('board', 'column', 'card', 'tag', 'relation', 'task')),
	CONSTRAINT "audit_events_entity_version_check" CHECK ("audit_events"."entity_version" >= 1),
	CONSTRAINT "audit_events_event_type_nonempty" CHECK (length("audit_events"."event_type") > 0),
	CONSTRAINT "audit_events_state_check" CHECK ("audit_events"."before_state" IS NOT NULL OR "audit_events"."after_state" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_columns_board_position_unique" UNIQUE("board_id","position"),
	CONSTRAINT "board_columns_board_id_id_unique" UNIQUE("board_id","id"),
	CONSTRAINT "board_columns_name_nonempty" CHECK (length(btrim("board_columns"."name")) > 0),
	CONSTRAINT "board_columns_position_check" CHECK ("board_columns"."position" >= 1),
	CONSTRAINT "board_columns_version_check" CHECK ("board_columns"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boards_name_nonempty" CHECK (length(btrim("boards"."name")) > 0),
	CONSTRAINT "boards_version_check" CHECK ("boards"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"original_content" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"position" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cards_column_position_unique" UNIQUE("column_id","position"),
	CONSTRAINT "cards_original_content_nonempty" CHECK (length(btrim("cards"."original_content")) > 0),
	CONSTRAINT "cards_title_nonempty" CHECK (length(btrim("cards"."title")) > 0),
	CONSTRAINT "cards_position_check" CHECK ("cards"."position" >= 1),
	CONSTRAINT "cards_version_check" CHECK ("cards"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_subject" text NOT NULL,
	"method" text NOT NULL,
	"route_template" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"response_headers" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_scope_unique" UNIQUE("principal_subject","method","route_template","idempotency_key"),
	CONSTRAINT "idempotency_records_subject_nonempty" CHECK (length("idempotency_records"."principal_subject") > 0),
	CONSTRAINT "idempotency_records_method_check" CHECK ("idempotency_records"."method" IN ('POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "idempotency_records_route_check" CHECK ("idempotency_records"."route_template" LIKE '/v1/%'),
	CONSTRAINT "idempotency_records_key_check" CHECK (length("idempotency_records"."idempotency_key") BETWEEN 8 AND 255 AND "idempotency_records"."idempotency_key" ~ '^[!-~]+$'),
	CONSTRAINT "idempotency_records_hash_nonempty" CHECK (length("idempotency_records"."request_hash") > 0),
	CONSTRAINT "idempotency_records_state_check" CHECK ("idempotency_records"."state" IN ('processing', 'completed')),
	CONSTRAINT "idempotency_records_response_check" CHECK (("idempotency_records"."state" = 'processing' AND "idempotency_records"."response_status" IS NULL AND "idempotency_records"."response_body" IS NULL AND "idempotency_records"."response_headers" IS NULL) OR ("idempotency_records"."state" = 'completed' AND "idempotency_records"."response_status" BETWEEN 200 AND 599 AND "idempotency_records"."response_body" IS NOT NULL AND "idempotency_records"."response_headers" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"sequence" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"last_dispatch_error" text,
	CONSTRAINT "outbox_events_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "outbox_events_aggregate_version_unique" UNIQUE("aggregate_type","aggregate_id","aggregate_version"),
	CONSTRAINT "outbox_events_aggregate_type_check" CHECK ("outbox_events"."aggregate_type" IN ('board', 'column', 'card', 'tag', 'relation', 'task')),
	CONSTRAINT "outbox_events_aggregate_version_check" CHECK ("outbox_events"."aggregate_version" >= 1),
	CONSTRAINT "outbox_events_event_type_nonempty" CHECK (length("outbox_events"."event_type") > 0),
	CONSTRAINT "outbox_events_dispatch_attempts_check" CHECK ("outbox_events"."dispatch_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_card_id" uuid NOT NULL,
	"to_card_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relations_directed_identity_unique" UNIQUE("from_card_id","to_card_id","relation_type"),
	CONSTRAINT "relations_distinct_cards_check" CHECK ("relations"."from_card_id" <> "relations"."to_card_id"),
	CONSTRAINT "relations_type_check" CHECK ("relations"."relation_type" IN ('related', 'supports', 'blocks', 'duplicates', 'references')),
	CONSTRAINT "relations_version_check" CHECK ("relations"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "card_tags" (
	"card_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_tags_pk" PRIMARY KEY("card_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name"),
	CONSTRAINT "tags_name_nonempty" CHECK (length(btrim("tags"."name")) > 0),
	CONSTRAINT "tags_color_check" CHECK ("tags"."color" IS NULL OR "tags"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"card_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_title_nonempty" CHECK (length(btrim("tasks"."title")) > 0),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('todo', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" IN ('low', 'normal', 'high', 'critical')),
	CONSTRAINT "tasks_dates_check" CHECK ("tasks"."starts_at" IS NULL OR "tasks"."due_at" IS NULL OR "tasks"."starts_at" <= "tasks"."due_at"),
	CONSTRAINT "tasks_version_check" CHECK ("tasks"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_compensates_event_id_audit_events_id_fk" FOREIGN KEY ("compensates_event_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_column_fk" FOREIGN KEY ("board_id","column_id") REFERENCES "public"."board_columns"("board_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_card_id_cards_id_fk" FOREIGN KEY ("from_card_id") REFERENCES "public"."cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_card_id_cards_id_fk" FOREIGN KEY ("to_card_id") REFERENCES "public"."cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_tags" ADD CONSTRAINT "card_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actors_updated_at_id_idx" ON "actors" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_id_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_compensates_event_id_idx" ON "audit_events" USING btree ("compensates_event_id");--> statement-breakpoint
CREATE INDEX "board_columns_board_position_idx" ON "board_columns" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "boards_updated_at_id_idx" ON "boards" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cards_updated_at_id_idx" ON "cards" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cards_board_updated_at_id_idx" ON "cards" USING btree ("board_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_records_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_events_dispatch_idx" ON "outbox_events" USING btree ("dispatched_at","available_at","sequence");--> statement-breakpoint
CREATE INDEX "outbox_events_occurred_at_idx" ON "outbox_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "relations_from_card_id_idx" ON "relations" USING btree ("from_card_id");--> statement-breakpoint
CREATE INDEX "relations_to_card_id_idx" ON "relations" USING btree ("to_card_id");--> statement-breakpoint
CREATE INDEX "card_tags_tag_id_idx" ON "card_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tags_updated_at_id_idx" ON "tags" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_updated_at_id_idx" ON "tasks" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_card_id_idx" ON "tasks" USING btree ("card_id");--> statement-breakpoint
CREATE FUNCTION reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION reject_audit_event_mutation();
