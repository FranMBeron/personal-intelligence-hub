import { z } from "zod";

import {
  NonEmptyStringSchema,
  NullableTimestampSchema,
  ResourceMetadataShape,
  TimestampSchema,
  UuidSchema,
} from "./common.js";

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done", "cancelled"]);
export const TaskPrioritySchema = z.enum(["low", "normal", "high", "critical"]);

const taskInputShape = {
  title: NonEmptyStringSchema.max(500),
  description: z.string().max(5000).nullable().optional(),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  dueAt: TimestampSchema.nullable().optional(),
  startsAt: TimestampSchema.nullable().optional(),
  cardId: UuidSchema.nullable().optional(),
} as const;

const datesAreOrdered = (value: {
  startsAt?: string | null | undefined;
  dueAt?: string | null | undefined;
}) =>
  value.startsAt == null ||
  value.dueAt == null ||
  new Date(value.startsAt).getTime() <= new Date(value.dueAt).getTime();

export const CreateTaskBodySchema = z
  .object(taskInputShape)
  .strict()
  .refine(datesAreOrdered, {
    path: ["dueAt"],
    message: "dueAt must not be earlier than startsAt.",
  });

export const PatchTaskBodySchema = z
  .object({
    title: taskInputShape.title.optional(),
    description: taskInputShape.description,
    status: taskInputShape.status,
    priority: taskInputShape.priority,
    dueAt: taskInputShape.dueAt,
    startsAt: taskInputShape.startsAt,
    cardId: taskInputShape.cardId,
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one task field must be supplied.",
  })
  .refine(datesAreOrdered, {
    path: ["dueAt"],
    message: "dueAt must not be earlier than startsAt.",
  });

export const TaskSchema = z
  .object({
    ...ResourceMetadataShape,
    title: NonEmptyStringSchema.max(500),
    description: z.string().max(5000).nullable(),
    status: TaskStatusSchema,
    priority: TaskPrioritySchema,
    dueAt: NullableTimestampSchema,
    startsAt: NullableTimestampSchema,
    completedAt: NullableTimestampSchema,
    cardId: UuidSchema.nullable(),
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;
export type PatchTaskBody = z.infer<typeof PatchTaskBodySchema>;
export type Task = z.infer<typeof TaskSchema>;
