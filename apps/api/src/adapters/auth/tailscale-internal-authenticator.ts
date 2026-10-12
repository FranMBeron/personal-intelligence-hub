import { PrincipalSchema, type Principal } from "@personal-intelligence-hub/contracts";
import { jwtVerify } from "jose";

import { InvalidTokenError } from "../../application/errors.js";
import type { Authenticator } from "../../application/ports/authenticator.js";

type Options = Readonly<{
  signingKey: string;
  clock?: () => Date;
}>;

export class TailscaleInternalAuthenticator implements Authenticator {
  readonly kind = "tailscale" as const;
  readonly #signingKey: Uint8Array;
  readonly #clock: () => Date;

  constructor({ signingKey, clock = () => new Date() }: Options) {
    if (signingKey.length < 32) {
      throw new Error("The internal authentication key must contain at least 32 characters.");
    }
    this.#signingKey = new TextEncoder().encode(signingKey);
    this.#clock = clock;
  }

  async authenticate(bearerToken: string): Promise<Principal> {
    try {
      const currentDate = this.#clock();
      const { payload } = await jwtVerify(bearerToken, this.#signingKey, {
        algorithms: ["HS256"],
        issuer: "personal-intelligence-hub-web",
        audience: "personal-intelligence-hub-api",
        currentDate,
      });
      if (
        payload.iat === undefined ||
        payload.exp === undefined ||
        payload.exp - payload.iat > 60 ||
        payload.iat > Math.floor(currentDate.getTime() / 1_000) + 5
      ) {
        throw new Error("Internal identity token lifetime is invalid.");
      }
      return PrincipalSchema.parse({
        subject: payload.sub,
        actorId: payload.actor_id,
        actorType: payload.actor_type,
        scopes: payload.scope,
        allowedSources: payload.allowed_sources,
      });
    } catch (error) {
      throw new InvalidTokenError(error);
    }
  }
}
