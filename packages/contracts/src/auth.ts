import { z } from "zod";

import { OpaqueNonEmptyStringSchema, UuidSchema } from "./common.js";

export const ActorTypeSchema = z.enum(["human", "agent", "service"]);

export const ScopeSchema = z.enum([
  "second-brain:read",
  "second-brain:write",
  "second-brain:compensate",
]);

export const ConnectorScopeSchema = z.enum([
  "health:read",
  "hermes:agents:read",
  "hermes:conversations:read",
  "hermes:conversations:write",
  "hermes:delegations:read",
  "calendar:read",
  "calendar:propose",
  "calendar:confirm",
  "calendar:configure",
  "system:read",
  "preferences:read",
  "preferences:write",
]);

export const ConnectorServiceIdSchema = z.enum([
  "pih-web",
  "hermes-central",
  "telegram-gateway",
  "pih-deployer",
]);

export const DelegatedPrincipalSchema = z
  .object({
    serviceId: ConnectorServiceIdSchema,
    subject: OpaqueNonEmptyStringSchema,
    actorId: UuidSchema,
    actorType: ActorTypeSchema,
    scopes: z.array(ConnectorScopeSchema),
    requestId: OpaqueNonEmptyStringSchema,
  })
  .strict();

export const DelegatedAuthorizationClaimsSchema = z
  .object({
    actor_id: UuidSchema,
    actor_type: ActorTypeSchema,
    scope: z.array(ConnectorScopeSchema),
    request_id: OpaqueNonEmptyStringSchema,
  })
  .strict();

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
export type ConnectorScope = z.infer<typeof ConnectorScopeSchema>;
export type ConnectorServiceId = z.infer<typeof ConnectorServiceIdSchema>;
export type DelegatedPrincipal = z.infer<typeof DelegatedPrincipalSchema>;
export type DelegatedAuthorizationClaims = z.infer<typeof DelegatedAuthorizationClaimsSchema>;
export type MutationSource = z.infer<typeof MutationSourceSchema>;
export type Principal = Readonly<{
  subject: string;
  actorId: string;
  actorType: ActorType;
  scopes: readonly Scope[];
  allowedSources: readonly MutationSource[];
}>;
