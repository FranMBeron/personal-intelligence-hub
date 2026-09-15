import { z } from "zod";

import {
  NonEmptyStringSchema,
  PositionSchema,
  ResourceMetadataShape,
  UuidSchema,
} from "./common.js";
import { TagSchema } from "./tags.js";

const OriginalContentSchema = z
  .string()
  .max(100_000)
  .refine((value) => value.trim().length > 0, {
    message: "Original content must contain a non-whitespace character.",
  });

export const CreateCardBodySchema = z
  .object({
    boardId: UuidSchema,
    columnId: UuidSchema,
    originalContent: OriginalContentSchema,
    title: NonEmptyStringSchema.max(500).optional(),
    summary: z.string().max(5000).nullable().optional(),
    position: PositionSchema.optional(),
  })
  .strict();

export const PatchCardBodySchema = z
  .object({
    title: NonEmptyStringSchema.max(500).optional(),
    summary: z.string().max(5000).nullable().optional(),
    columnId: UuidSchema.optional(),
    position: PositionSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one card field must be supplied.",
  });

export const CardSchema = z
  .object({
    ...ResourceMetadataShape,
    boardId: UuidSchema,
    columnId: UuidSchema,
    originalContent: OriginalContentSchema,
    title: NonEmptyStringSchema.max(500),
    summary: z.string().max(5000).nullable(),
    position: PositionSchema,
    tags: z.array(TagSchema),
  })
  .strict();

export type CreateCardBody = z.infer<typeof CreateCardBodySchema>;
export type PatchCardBody = z.infer<typeof PatchCardBodySchema>;
export type Card = z.infer<typeof CardSchema>;
