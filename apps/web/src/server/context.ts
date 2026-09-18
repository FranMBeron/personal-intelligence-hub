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

export const deriveRequestContext = (
  headers: Headers,
  requestIdFactory: () => string = randomUUID,
): RequestContextResult => {
  const suppliedRequestId = headers.get("x-request-id");
  const requestId = UuidSchema.safeParse(suppliedRequestId).success
    ? suppliedRequestId!
    : requestIdFactory();
  const authorization = headers.get("authorization");

  if (authorization === null || !/^Bearer\s+\S+$/iu.test(authorization)) {
    return {
      ok: false,
      problem: {
        type: "about:blank",
        title: "Authentication required",
        status: 401,
        detail: "A delegated bearer authorization is required.",
        instance: "/api/ui/v1",
        code: "authentication_required",
        requestId,
      },
    };
  }

  return { ok: true, context: { authorization, requestId } };
};
