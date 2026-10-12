import { describe, expect, it } from "vitest";

import {
  DelegatedJwtKeySchema,
  MutationSourceSchema,
  PrincipalSchema,
  ScopeSchema,
} from "./auth.js";

const principal = {
  subject: "oidc|fictional-user",
  actorId: "9e0b3a85-4336-4262-900d-b06f9d5f1f42",
  actorType: "human",
  scopes: ["second-brain:read", "second-brain:write"],
  allowedSources: ["pih", "hermes-web"],
} as const;

describe("authentication contracts", () => {
  it("shares the canonical 32-byte base64url delegated key format", () => {
    const encoded = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expect(DelegatedJwtKeySchema.parse(encoded)).toEqual(new Uint8Array(32).fill(7));
    const thirtyThreeBytes = btoa(String.fromCharCode(...new Uint8Array(33).fill(7)))
      .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expect(DelegatedJwtKeySchema.safeParse(thirtyThreeBytes).success).toBe(false);
    expect(DelegatedJwtKeySchema.safeParse(`${encoded}=`).success).toBe(false);
  });

  it("accepts a trusted principal with the frozen scopes and sources", () => {
    expect(PrincipalSchema.parse(principal)).toEqual(principal);
  });

  it("preserves the case-sensitive OIDC subject exactly", () => {
    const subject = " tenant|fictional-user ";

    expect(PrincipalSchema.parse({ ...principal, subject }).subject).toBe(subject);
  });

  it.each([
    "second-brain:read",
    "second-brain:write",
    "second-brain:compensate",
  ])("accepts the scope %s", (scope) => {
    expect(ScopeSchema.parse(scope)).toBe(scope);
  });

  it.each(["pih", "telegram", "hermes-web", "automation", "test"])(
    "accepts the mutation source %s",
    (source) => {
      expect(MutationSourceSchema.parse(source)).toBe(source);
    },
  );

  it("rejects a principal with an unrecognized authority value", () => {
    expect(() =>
      PrincipalSchema.parse({
        ...principal,
        scopes: ["second-brain:admin"],
      }),
    ).toThrow();
  });

  it("rejects authority fields that were not issued by the authenticator", () => {
    expect(() => PrincipalSchema.parse({ ...principal, role: "owner" })).toThrow();
  });
});
