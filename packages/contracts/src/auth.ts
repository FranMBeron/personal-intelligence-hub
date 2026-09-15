import { z } from "zod";

import { OpaqueNonEmptyStringSchema, UuidSchema } from "./common.js";

export const ActorTypeSchema = z.enum(["human", "agent", "service"]);

export const ScopeSchema = z.enum([
  "second-brain:read",
  "second-brain:write",
  "second-brain:compensate",
]);

export const MutationSourceSchema = z.enum([
  "pih",
  "telegram",
  "hermes-web",
  "automation",
  "test",
]);

export const PrincipalSchema = z
  .object({
    subject: OpaqueNonEmptyStringSchema,
    actorId: UuidSchema,
    actorType: ActorTypeSchema,
    scopes: z.array(ScopeSchema),
    allowedSources: z.array(MutationSourceSchema),
  })
  .strict();

export type ActorType = z.infer<typeof ActorTypeSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type MutationSource = z.infer<typeof MutationSourceSchema>;
export type Principal = Readonly<{
  subject: string;
  actorId: string;
  actorType: ActorType;
  scopes: readonly Scope[];
  allowedSources: readonly MutationSource[];
}>;
