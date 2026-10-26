import { z } from "zod";

import { OpaqueNonEmptyStringSchema, UuidSchema } from "./common.js";

export const ActorTypeSchema = z.enum(["human", "agent", "service"]);

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

export const DelegatedJwtKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .transform((encoded, context) => {
    let decoded: Uint8Array;
    try {
      const base64 = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
      const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      context.addIssue({ code: "custom", message: "delegated key must be canonical base64url" });
      return z.NEVER;
    }
    if (decoded.byteLength !== 32 || base64UrlEncode(decoded) !== encoded) {
      context.addIssue({ code: "custom", message: "delegated key must encode exactly 32 bytes" });
      return z.NEVER;
    }
    return decoded;
  });

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
  "devices:read",
  "devices:write",
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
