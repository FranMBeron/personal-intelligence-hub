import { PrincipalSchema, type Principal } from "@personal-intelligence-hub/contracts";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import { InvalidTokenError } from "../../application/errors.js";
import type { Authenticator } from "../../application/ports/authenticator.js";

export type OidcAlgorithm = "RS256" | "ES256";

export type OidcJwtAuthenticatorOptions = Readonly<{
  issuer: string;
  audience: string;
  jwksUri: string;
  algorithms: readonly OidcAlgorithm[];
  keyResolver?: JWTVerifyGetKey;
  clock?: () => Date;
}>;

const readScopes = (scope: unknown): string[] => {
  if (typeof scope === "string") {
    return scope.split(/\s+/u).filter((value) => value.length > 0);
  }
  if (Array.isArray(scope)) {
    return scope.filter((value): value is string => typeof value === "string");
  }
  return [];
};

export class OidcJwtAuthenticator implements Authenticator {
  readonly kind = "oidc" as const;
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly clock: () => Date;

  constructor(private readonly options: OidcJwtAuthenticatorOptions) {
    if (
      options.algorithms.length === 0 ||
      options.algorithms.some(
        (algorithm) => algorithm !== "RS256" && algorithm !== "ES256",
      )
    ) {
      throw new Error("OIDC algorithms must be a non-empty RS256/ES256 allow-list.");
    }
    this.keyResolver =
      options.keyResolver ?? createRemoteJWKSet(new URL(options.jwksUri));
    this.clock = options.clock ?? (() => new Date());
  }

  async authenticate(bearerToken: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(bearerToken, this.keyResolver, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: [...this.options.algorithms],
        currentDate: this.clock(),
      });

      return PrincipalSchema.parse({
        subject: payload.sub,
        actorId: payload.actor_id,
        actorType: payload.actor_type,
        scopes: readScopes(payload.scope ?? payload.scopes),
        allowedSources: payload.allowed_sources,
      });
    } catch (error) {
      throw new InvalidTokenError(error);
    }
  }
}
