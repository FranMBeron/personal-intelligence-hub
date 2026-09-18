import { z } from "zod";

import { ActorTypeSchema, MutationSourceSchema } from "./auth.js";
import { BoardSnapshotSchema } from "./boards.js";
import { CardSchema } from "./cards.js";
import {
  AggregateTypeSchema,
  DecimalSequenceSchema,
  OpaqueNonEmptyStringSchema,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from "./common.js";
import { MutationMethodSchema } from "./http.js";
import { RelationSchema } from "./relations.js";
import { TaskSchema } from "./tasks.js";

export const AuditEventSchema = z
  .object({
    id: UuidSchema,
    principalSubject: OpaqueNonEmptyStringSchema,
    actorId: UuidSchema,
    actorType: ActorTypeSchema,
    source: MutationSourceSchema,
    requestId: UuidSchema,
    routeTemplate: z.string().startsWith("/v1/"),
    method: MutationMethodSchema,
    entityType: AggregateTypeSchema,
    entityId: UuidSchema,
    entityVersion: VersionSchema,
    eventType: OpaqueNonEmptyStringSchema,
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    occurredAt: TimestampSchema,
    compensatesEventId: UuidSchema.nullable(),
  })
  .strict();

export const CompensateAuditEventBodySchema = z.object({}).strict();

const BoardCreatedPayloadSchema = z
  .object({
    kind: z.literal("board.created"),
    boardId: UuidSchema,
  })
  .strict();

const CardCreatedPayloadSchema = z
  .object({
    kind: z.literal("card.created"),
    cardId: UuidSchema,
    boardId: UuidSchema,
  })
  .strict();

const CardUpdatedPayloadSchema = z
  .object({
    kind: z.literal("card.updated"),
    cardId: UuidSchema,
    boardId: UuidSchema,
    changedFields: z.array(OpaqueNonEmptyStringSchema).min(1),
  })
  .strict();

const CardTagPayloadSchema = z
  .object({
    kind: z.enum(["card.tagged", "card.untagged"]),
    cardId: UuidSchema,
    boardId: UuidSchema,
    tagId: UuidSchema,
  })
  .strict();

const RelationPayloadSchema = z
  .object({
    kind: z.enum(["relation.created", "relation.archived"]),
    relationId: UuidSchema,
    fromCardId: UuidSchema,
    toCardId: UuidSchema,
  })
  .strict();

const TaskCreatedPayloadSchema = z
  .object({
    kind: z.literal("task.created"),
    taskId: UuidSchema,
  })
  .strict();

const TaskUpdatedPayloadSchema = z
  .object({
    kind: z.literal("task.updated"),
    taskId: UuidSchema,
    changedFields: z.array(OpaqueNonEmptyStringSchema).min(1),
  })
  .strict();

const CompensationCreatedPayloadSchema = z
  .object({
    kind: z.literal("compensation.created"),
    entityType: AggregateTypeSchema,
    entityId: UuidSchema,
    compensatesEventId: UuidSchema,
  })
  .strict();

export const PublicEventPayloadSchema = z.discriminatedUnion("kind", [
  BoardCreatedPayloadSchema,
  CardCreatedPayloadSchema,
  CardUpdatedPayloadSchema,
  CardTagPayloadSchema,
  RelationPayloadSchema,
  TaskCreatedPayloadSchema,
  TaskUpdatedPayloadSchema,
  CompensationCreatedPayloadSchema,
]);

export const OutboxEventTypeSchema = z.enum([
  "board.created",
  "card.created",
  "card.updated",
  "card.tagged",
  "card.untagged",
  "relation.created",
  "relation.archived",
  "task.created",
  "task.updated",
  "compensation.created",
]);

export const OutboxEventSchema = z
  .object({
    eventId: UuidSchema,
    sequence: DecimalSequenceSchema,
    aggregateType: AggregateTypeSchema,
    aggregateId: UuidSchema,
    aggregateVersion: VersionSchema,
    eventType: OutboxEventTypeSchema,
    occurredAt: TimestampSchema,
    payload: PublicEventPayloadSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.eventType !== value.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "payload.kind must equal eventType.",
      });
    }

    const expectedAggregate = (() => {
      switch (value.payload.kind) {
        case "board.created":
          return { type: "board", id: value.payload.boardId } as const;
        case "card.created":
        case "card.updated":
        case "card.tagged":
        case "card.untagged":
          return { type: "card", id: value.payload.cardId } as const;
        case "relation.created":
        case "relation.archived":
          return { type: "relation", id: value.payload.relationId } as const;
        case "task.created":
        case "task.updated":
          return { type: "task", id: value.payload.taskId } as const;
        case "compensation.created":
          return {
            type: value.payload.entityType,
            id: value.payload.entityId,
          } as const;
      }
    })();

    if (value.aggregateType !== expectedAggregate.type) {
      context.addIssue({
        code: "custom",
        path: ["aggregateType"],
        message: "aggregateType must match the public payload.",
      });
    }
    if (value.aggregateId !== expectedAggregate.id) {
      context.addIssue({
        code: "custom",
        path: ["aggregateId"],
        message: "aggregateId must match the public payload.",
      });
    }
  });

export const SnapshotSchema = z
  .object({
    generatedAt: TimestampSchema,
    lastSequence: DecimalSequenceSchema,
    boards: z.array(BoardSnapshotSchema),
    cards: z.array(CardSchema),
    relations: z.array(RelationSchema),
    tasks: z.array(TaskSchema),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type CompensateAuditEventBody = z.infer<
  typeof CompensateAuditEventBodySchema
>;
export type PublicEventPayload = z.infer<typeof PublicEventPayloadSchema>;
export type OutboxEventType = z.infer<typeof OutboxEventTypeSchema>;
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
