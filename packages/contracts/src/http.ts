import { z } from "zod";

import type { MutationSource, Principal } from "./auth.js";
import { MutationSourceSchema } from "./auth.js";
import { TimestampSchema, UuidSchema } from "./common.js";

export const RequestIdSchema = UuidSchema.brand<"RequestId">();
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7E]+$/)
  .brand<"IdempotencyKey">();
export const CursorSchema = z.string().min(1).max(4096).brand<"Cursor">();

const strongETagPattern =
  /^"(?:board|column|card|tag|relation|task):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}:[1-9]\d*"$/;

export const ETagSchema = z.string().regex(strongETagPattern).brand<"ETag">();
export const IfMatchSchema = ETagSchema;
export const OriginChannelHeaderSchema = MutationSourceSchema;

export const PaginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: CursorSchema.optional(),
  })
  .strict();

export const PageInfoSchema = z
  .object({
    nextCursor: CursorSchema.nullable(),
    hasNextPage: z.boolean(),
  })
  .strict();

export const createPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      items: z.array(itemSchema),
      pageInfo: PageInfoSchema,
    })
    .strict();

export const CursorBindingSchema = z
  .object({
    route: z.string().startsWith("/v1/"),
    filterHash: z.string().min(1),
  })
  .strict();

export const CursorPayloadSchema = CursorBindingSchema.extend({
  version: z.literal(1),
  sort: z
    .object({
      value: TimestampSchema,
      id: UuidSchema,
    })
    .strict(),
}).strict();

export const MutationMethodSchema = z.enum(["POST", "PUT", "PATCH", "DELETE"]);

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type ETag = z.infer<typeof ETagSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type CursorBinding = z.infer<typeof CursorBindingSchema>;
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;
export type MutationMethod = z.infer<typeof MutationMethodSchema>;
export type MutationContext = Readonly<{
  principal: Principal;
  source: MutationSource;
  requestId: string;
  idempotencyKey: string;
  routeTemplate: string;
  method: MutationMethod;
  expectedVersion?: number;
  expectedEtag?: string;
}>;
