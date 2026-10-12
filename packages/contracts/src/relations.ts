import { z } from "zod";

import { ResourceMetadataShape, UuidSchema } from "./common.js";

export const RelationTypeSchema = z.enum([
  "related",
  "supports",
  "blocks",
  "duplicates",
  "references",
]);

export const CreateRelationBodySchema = z
  .object({
    fromCardId: UuidSchema,
    toCardId: UuidSchema,
    type: RelationTypeSchema,
  })
  .strict()
  .refine((value) => value.fromCardId !== value.toCardId, {
    path: ["toCardId"],
    message: "A card cannot relate to itself.",
  });

export const RelationSchema = z
  .object({
    ...ResourceMetadataShape,
    fromCardId: UuidSchema,
    toCardId: UuidSchema,
    type: RelationTypeSchema,
  })
  .strict()
  .refine((value) => value.fromCardId !== value.toCardId, {
    path: ["toCardId"],
    message: "A card cannot relate to itself.",
  });

export type RelationType = z.infer<typeof RelationTypeSchema>;
export type CreateRelationBody = z.infer<typeof CreateRelationBodySchema>;
export type Relation = z.infer<typeof RelationSchema>;
