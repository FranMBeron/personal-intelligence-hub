import { z } from "zod";

import {
  NonEmptyStringSchema,
  PositionSchema,
  ResourceMetadataShape,
  UuidSchema,
} from "./common.js";

export const BoardColumnInputSchema = z
  .object({
    name: NonEmptyStringSchema.max(120),
    position: PositionSchema,
  })
  .strict();

const hasSequentialPositions = (columns: readonly { position: number }[]) =>
  columns.every((column, index) => column.position === index + 1);

export const CreateBoardBodySchema = z
  .object({
    name: NonEmptyStringSchema.max(120),
    description: z.string().max(2000).nullable().optional(),
    columns: z.array(BoardColumnInputSchema).min(1).max(50),
  })
  .strict()
  .refine((value) => hasSequentialPositions(value.columns), {
    path: ["columns"],
    message: "Column positions must be sequential and start at 1.",
  });

export const BoardSchema = z
  .object({
    ...ResourceMetadataShape,
    name: NonEmptyStringSchema.max(120),
    description: z.string().max(2000).nullable(),
  })
  .strict();

export const BoardColumnSchema = z
  .object({
    ...ResourceMetadataShape,
    boardId: UuidSchema,
    name: NonEmptyStringSchema.max(120),
    position: PositionSchema,
  })
  .strict();

export const BoardSnapshotSchema = BoardSchema.extend({
  columns: z.array(BoardColumnSchema),
})
  .strict()
  .refine((value) => hasSequentialPositions(value.columns), {
    path: ["columns"],
    message: "Columns must be ordered by sequential position.",
  });

export type CreateBoardBody = z.infer<typeof CreateBoardBodySchema>;
export type Board = z.infer<typeof BoardSchema>;
export type BoardColumn = z.infer<typeof BoardColumnSchema>;
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;
