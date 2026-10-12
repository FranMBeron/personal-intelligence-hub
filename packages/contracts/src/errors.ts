import { z } from "zod";

import { UuidSchema } from "./common.js";

export const ApiProblemCodeSchema = z.enum([
  "authentication_required",
  "invalid_token",
  "forbidden",
  "payload_too_large",
  "too_many_requests",
  "validation_failed",
  "not_found",
  "precondition_required",
  "version_conflict",
  "idempotency_key_required",
  "idempotency_key_reused",
  "invalid_cursor",
  "cursor_expired",
  "conflict",
  "internal_error",
  "dependency_unavailable",
]);

export const ApiProblemValidationErrorSchema = z
  .object({
    path: z.string().min(1),
    message: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();

export const ApiProblemSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1),
    instance: z.string().min(1),
    code: ApiProblemCodeSchema,
    requestId: UuidSchema,
    errors: z.array(ApiProblemValidationErrorSchema).optional(),
  })
  .strict();

export type ApiProblemCode = z.infer<typeof ApiProblemCodeSchema>;
export type ApiProblem = z.infer<typeof ApiProblemSchema>;
