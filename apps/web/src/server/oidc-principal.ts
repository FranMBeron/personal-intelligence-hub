import "server-only";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { UuidSchema } from "@personal-intelligence-hub/contracts";

import type { VerifiedPrincipal } from "./context";

export type PrincipalResolution =
  | Readonly<{ ok: true; principal: VerifiedPrincipal }>
  | Readonly<{
      ok: false;
      status: 401 | 403;
      title: string;
      detail: string;
    }>;

type OidcPrincipalVerifierOptions = Readonly<{
  issuer: string;
  audience: string;
  jwksUri: string;
  getKey?: JWTVerifyGetKey;
  clock?: () => Date;
}>;

const invalidBearer: PrincipalResolution = {
  ok: false,
  status: 401,
  title: "Authentication required",
  detail: "A valid OIDC bearer token is required.",
};
const invalidActor: PrincipalResolution = {
  ok: false,
  status: 403,
  title: "Forbidden",
  detail: "The authenticated identity is not an allowed human actor.",
};

export class OidcPrincipalVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly clock: () => Date;

  constructor(private readonly options: OidcPrincipalVerifierOptions) {
    const jwksUrl = new URL(options.jwksUri);
    if (jwksUrl.protocol !== "https:" || jwksUrl.username !== "" || jwksUrl.password !== "") {
      throw new Error("The configured OIDC JWKS URL must be an uncredentialed HTTPS URL.");
    }
    if (options.issuer.trim() === "" || options.audience.trim() === "") {
      throw new Error("The configured OIDC issuer and audience are required.");
    }
    this.getKey = options.getKey ?? createRemoteJWKSet(jwksUrl);
    this.clock = options.clock ?? (() => new Date());
  }

  async resolve(headers: Headers): Promise<PrincipalResolution> {
    const authorization = headers.get("authorization");
    const match = authorization?.match(/^Bearer\s+(\S+)$/iu);
    if (match?.[1] === undefined) return invalidBearer;

    try {
      const { payload } = await jwtVerify(match[1], this.getKey, {
        algorithms: ["RS256", "ES256"],
        issuer: this.options.issuer,
        audience: this.options.audience,
        currentDate: this.clock(),
      });
      if (
        typeof payload.sub !== "string" ||
        payload.sub.trim() === "" ||
        payload.actor_type !== "human" ||
        typeof payload.actor_id !== "string" ||
        !UuidSchema.safeParse(payload.actor_id).success
      ) {
        return invalidActor;
      }
      return {
        ok: true,
        principal: {
          actorId: payload.actor_id,
          subject: payload.sub,
          actorType: "human",
        },
      };
    } catch {
      return invalidBearer;
    }
  }
}
