import "server-only";

import { randomUUID } from "node:crypto";

import { UuidSchema, type ApiProblem } from "@personal-intelligence-hub/contracts";

export type RequestContext = Readonly<{
  authorization: string;
  requestId: string;
}>;

export type RequestContextResult =
  | Readonly<{ ok: true; context: RequestContext }>
  | Readonly<{ ok: false; problem: ApiProblem }>;

export type IdentityResolution =
  | Readonly<{ ok: true; authorization: string }>
  | Readonly<{
      ok: false;
      status: 401 | 403;
      title: string;
      detail: string;
    }>;

export interface RequestIdentityAdapter {
  resolve(headers: Headers): Promise<IdentityResolution>;
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
    return { ok: true, authorization };
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
  const resolution = await identity.resolve(headers);

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
    context: { authorization: resolution.authorization, requestId },
  };
  }
};
