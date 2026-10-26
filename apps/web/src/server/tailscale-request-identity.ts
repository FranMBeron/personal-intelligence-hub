import "server-only";

import { webcrypto } from "node:crypto";

import { SignJWT } from "jose";

import { UuidSchema } from "@personal-intelligence-hub/contracts";

import type {
  IdentityRequestMetadata,
  IdentityResolution,
  RequestIdentityAdapter,
  VerifiedPrincipal,
} from "./context";

type Options = Readonly<{
  allowedUsers: Readonly<Record<string, string>>;
  signingKey: string;
  clock?: () => Date;
}>;

const missingIdentity = (): IdentityResolution => ({
  ok: false,
  status: 401,
  title: "Authentication required",
  detail: "A Tailscale user identity from the trusted local proxy is required.",
});


export const signTailscalePrincipalAuthorization = async (
  principal: VerifiedPrincipal,
  signingKey: string,
  clock: () => Date = () => new Date(),
): Promise<string> => {
  if (
    principal.actorType !== "human" ||
    !principal.subject.startsWith("tailscale:") ||
    !UuidSchema.safeParse(principal.actorId).success ||
    Buffer.byteLength(signingKey, "utf8") < 32
  ) {
    throw new Error("Cannot authorize an unverified Tailscale principal.");
  }
  const issuedAt = Math.floor(clock().getTime() / 1_000);
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(signingKey, "utf8"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const token = await new SignJWT({
    actor_id: principal.actorId,
    actor_type: "human",
    scope: ["second-brain:read", "second-brain:write", "second-brain:compensate"],
    allowed_sources: ["pih"],
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.subject)
    .setIssuer("personal-intelligence-hub-web")
    .setAudience("personal-intelligence-hub-api")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 30)
    .sign(key);
  return `Bearer ${token}`;
};

const normalizeLogin = (value: string): string | null => {
  if (
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 320 ||
    value.includes(",") ||
    value.startsWith("=?") ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    return null;
  }
  return value.toLowerCase();
};

export class TailscaleRequestIdentity implements RequestIdentityAdapter {
  readonly #allowedUsers: ReadonlyMap<string, string>;
  readonly #signingKey: Uint8Array;
  readonly #clock: () => Date;

  constructor({ allowedUsers, signingKey, clock = () => new Date() }: Options) {
    if (signingKey.length < 32) {
      throw new Error("The internal authentication key must contain at least 32 characters.");
    }
    const entries = Object.entries(allowedUsers).map(([login, actorId]) => {
      const normalized = normalizeLogin(login);
      if (normalized === null) {
        throw new Error("Tailscale allow-list logins must be unambiguous visible ASCII.");
      }
      return [normalized, actorId] as const;
    });
    if (entries.length === 0) {
      throw new Error("Tailscale authentication requires at least one allowed user.");
    }
    this.#allowedUsers = new Map(entries);
    this.#signingKey = new TextEncoder().encode(signingKey);
    this.#clock = clock;
  }

  async resolve(headers: Headers, metadata?: IdentityRequestMetadata): Promise<IdentityResolution> {
    // Tailscale Serve strips and re-adds this header, but only connections from Serve are trusted:
    // they arrive on the private Unix listener. Any TCP client could forge the header.
    if (metadata?.trustedProxy !== true) return missingIdentity();
    const suppliedLogin = headers.get("tailscale-user-login");
    if (suppliedLogin === null) return missingIdentity();
    const login = normalizeLogin(suppliedLogin);
    if (login === null) return missingIdentity();
    const actorId = this.#allowedUsers.get(login);
    if (actorId === undefined) {
      return {
        ok: false,
        status: 403,
        title: "Forbidden",
        detail: "The authenticated Tailscale user is not allowed to use this deployment.",
      };
    }

    const principal: VerifiedPrincipal = {
      actorId,
      subject: `tailscale:${login}`,
      actorType: "human",
    };
    const authorization = await signTailscalePrincipalAuthorization(
      principal,
      new TextDecoder().decode(this.#signingKey),
      this.#clock,
    );

    return {
      ok: true,
      authorization,
      concurrencyKey: `tailscale:${login}`,
    };
  }
}
