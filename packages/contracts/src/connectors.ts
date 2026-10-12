import { z } from "zod";

import {
  NonEmptyStringSchema,
  OpaqueNonEmptyStringSchema,
  TimestampSchema,
} from "./common.js";

export const SourceStateSchema = z.enum([
  "not_configured",
  "available",
  "degraded",
  "requires_reauthorization",
  "requires_attention",
  "unavailable",
]);

export const SourceStatusSchema = z
  .object({
    id: OpaqueNonEmptyStringSchema,
    state: SourceStateSchema,
    checkedAt: TimestampSchema,
    lastSuccessAt: TimestampSchema.optional(),
    stale: z.boolean(),
    capabilities: z.array(NonEmptyStringSchema).readonly(),
    safeReasonCode: NonEmptyStringSchema.optional(),
  })
  .strict();

export const SystemStatusSchema = z.object({ sources: z.array(SourceStatusSchema) }).strict();

export type SourceState = z.infer<typeof SourceStateSchema>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
