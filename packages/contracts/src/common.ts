import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime({ offset: true });
export const VersionSchema = z.number().int().min(1);
export const PositionSchema = z.number().int().min(1);
export const DecimalSequenceSchema = z.string().regex(/^(?:0|[1-9]\d*)$/);
export const NonEmptyStringSchema = z.string().min(1).regex(/\S/);
export const OpaqueNonEmptyStringSchema = z.string().min(1);
export const NullableTimestampSchema = TimestampSchema.nullable();

export const AggregateTypeSchema = z.enum([
  "board",
  "column",
  "card",
  "tag",
  "relation",
  "task",
]);

export const ResourceMetadataShape = {
  id: UuidSchema,
  version: VersionSchema,
  archivedAt: NullableTimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
} as const;

export type AggregateType = z.infer<typeof AggregateTypeSchema>;
