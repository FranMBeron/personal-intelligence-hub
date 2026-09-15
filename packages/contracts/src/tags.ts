import { z } from "zod";

import {
  NonEmptyStringSchema,
  TimestampSchema,
  UuidSchema,
  VersionSchema,
} from "./common.js";

export const TagSchema = z
  .object({
    id: UuidSchema,
    name: NonEmptyStringSchema.max(64),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const CardTagMembershipSchema = z
  .object({
    cardId: UuidSchema,
    tagId: UuidSchema,
    cardVersion: VersionSchema,
    tags: z.array(TagSchema),
  })
  .strict();

export type Tag = z.infer<typeof TagSchema>;
export type CardTagMembership = z.infer<typeof CardTagMembershipSchema>;
