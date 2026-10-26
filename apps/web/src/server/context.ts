import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { UuidSchema, type ApiProblem } from "@personal-intelligence-hub/contracts";

import { getImmediatePeerAddress, isTrustedProxyPeer } from "./peer-address";

export type VerifiedPrincipal = Readonly<{
  actorId: string;
  subject: string;
  actorType: "human";
}>;

export type RequestContext = Readonly<{
  authorization: string;
  concurrencyKey: string;
  requestId: string;
  principal?: VerifiedPrincipal;
}>;

export type RequestContextResult =
  | Readonly<{ ok: true; context: RequestContext }>
  | Readonly<{ ok: false; problem: ApiProblem }>;

export type IdentityFailure = Readonly<{
  ok: false;
  status: 401 | 403;
  title: string;
  detail: string;
}>;

export type IdentityResolution =
  | Readonly<{
      ok: true;
      authorization: string;
      concurrencyKey: string;
      principal?: VerifiedPrincipal;
    }>
  | IdentityFailure;

/**
 * Transport facts captured by the peer server. `trustedProxy` is true only for requests that
 * arrived on the private trusted-proxy Unix listener; `peerAddress` is the TCP peer IP otherwise.
 */
export type IdentityRequestMetadata = Readonly<{ peerAddress?: string; trustedProxy: boolean }>;

export interface RequestIdentityAdapter {
  resolve(headers: Headers, metadata?: IdentityRequestMetadata): Promise<IdentityResolution>;
}

export const oidcRequestIdentity: RequestIdentityAdapter = {
  async resolve(headers) {
    const authorization = headers.get("authorization");
    if (authorization === null || !/^Bearer\s+\S+$/iu.test(authorization)) {
      return {
        ok: false,
        status: 401,
        title: "Authentication required",
        detail: "A delegated bearer authorization is required.",
      };
    }
    return {
      ok: true,
      authorization,
      concurrencyKey: `oidc:${createHash("sha256").update(authorization).digest("base64url")}`,
    };
  },
};

export const deriveRequestContext = (
  headers: Headers,
  requestIdFactory: () => string = randomUUID,
  identity: RequestIdentityAdapter = oidcRequestIdentity,
): Promise<RequestContextResult> => {
  return derive();

  async function derive(): Promise<RequestContextResult> {
    const suppliedRequestId = headers.get("x-request-id");
    const requestId = UuidSchema.safeParse(suppliedRequestId).success
      ? suppliedRequestId!
      : requestIdFactory();
    const peer = getImmediatePeerAddress();
    const metadata: IdentityRequestMetadata = isTrustedProxyPeer(peer)
      ? { trustedProxy: true }
      : peer === undefined || isIP(peer) === 0
        ? { trustedProxy: false }
        : { peerAddress: peer, trustedProxy: false };
    const resolution = await identity.resolve(headers, metadata);

    if (!resolution.ok) {
      return {
        ok: false,
        problem: {
          type: "about:blank",
          title: resolution.title,
          status: resolution.status,
          detail: resolution.detail,
          instance: "/api/ui/v1",
          code: resolution.status === 401 ? "authentication_required" : "forbidden",
          requestId,
        },
      };
    }

    return {
      ok: true,
      context: {
        authorization: resolution.authorization,
        concurrencyKey: resolution.concurrencyKey,
        requestId,
        ...(resolution.principal === undefined ? {} : { principal: resolution.principal }),
      },
    };
  }
};
