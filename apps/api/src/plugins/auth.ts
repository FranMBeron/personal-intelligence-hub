import rateLimit from "@fastify/rate-limit";
import {
  ETagSchema,
  IdempotencyKeySchema,
  MutationSourceSchema,
  type MutationContext,
  type MutationMethod,
  type MutationSource,
  type Principal,
  type Scope,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import {
  ApplicationError,
  AuthenticationRequiredError,
  ForbiddenError,
  IdempotencyKeyRequiredError,
  InvalidTokenError,
  PreconditionRequiredError,
  ValidationError,
} from "../application/errors.js";
import type { Authenticator } from "../application/ports/authenticator.js";

export type RouteSecurity = Readonly<{
  scopes?: readonly Scope[];
  mutation?: boolean;
  requireIfMatch?: boolean;
}>;

declare module "fastify" {
  interface FastifyContextConfig {
    pihSecurity?: RouteSecurity;
  }

  interface FastifyRequest {
    principal?: Principal;
    mutationContext?: MutationContext;
  }
}

const mutationMethods = new Set<MutationMethod>([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const protectedPath = (requestUrl: string): boolean => {
  const path = requestUrl.split("?", 1)[0];
  return path === "/health/ready" || path?.startsWith("/v1/") === true;
};

const singleHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const bearerToken = (authorization: string | undefined): string => {
  if (authorization === undefined) {
    throw new AuthenticationRequiredError();
  }
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  if (match?.[1] === undefined) {
    throw new InvalidTokenError();
  }
  return match[1];
};

const defaultScopes = (method: string): readonly Scope[] =>
  method === "GET" || method === "HEAD"
    ? ["second-brain:read"]
    : ["second-brain:write"];

const parseExpectedVersion = (etag: string): number => {
  const withoutQuote = etag.slice(1, -1);
  const version = Number(withoutQuote.slice(withoutQuote.lastIndexOf(":") + 1));
  return version;
};

const invalidHeader = (
  path: string,
  message: string,
  code = "invalid_format",
): ValidationError => new ValidationError([{ path, message, code }]);

export const installAuthentication = (
  app: FastifyInstance,
  authenticator: Authenticator,
): void => {
  app.decorateRequest("principal");
  app.decorateRequest("mutationContext");

  // A shared socket-address budget also bounds missing/invalid credentials.
  // Identity and forwarded headers are untrusted before authentication.
  void app.register(rateLimit, {
    global: false,
    max: 1_000,
    timeWindow: 60_000,
    allowList: (request) => !protectedPath(request.url),
    errorResponseBuilder: () => new ApplicationError("too_many_requests"),
  });

  // Resolve the decorated limiter after plugin initialization, on requests.
  // A parent hook must precede auth; automatic route hooks run after it.
  app.addHook("onRequest", async (request, reply) => {
    const limitRequest = app.rateLimit();
    await limitRequest.call(app, request, reply);
  });

  app.addHook("onRequest", async (request) => {
    if (!protectedPath(request.url)) {
      return;
    }

    const token = bearerToken(singleHeader(request.headers.authorization));
    let principal: Principal;
    try {
      principal = await authenticator.authenticate(token);
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new InvalidTokenError(error);
    }
    request.principal = principal;

    const security = request.routeOptions.config.pihSecurity;
    const requiredScopes = security?.scopes ?? defaultScopes(request.method);
    if (requiredScopes.some((scope) => !principal.scopes.includes(scope))) {
      throw new ForbiddenError();
    }

    const method = request.method as MutationMethod;
    const mutation = security?.mutation ?? mutationMethods.has(method);
    if (!mutation) {
      return;
    }

    if (!mutationMethods.has(method)) {
      throw new Error("Mutation security can only be used with mutation methods.");
    }

    const sourceValue = singleHeader(request.headers["x-origin-channel"]);
    const sourceResult = MutationSourceSchema.safeParse(sourceValue);
    if (!sourceResult.success || !principal.allowedSources.includes(sourceResult.data)) {
      throw new ForbiddenError();
    }
    const source: MutationSource = sourceResult.data;

    const idempotencyValue = singleHeader(request.headers["idempotency-key"]);
    if (idempotencyValue === undefined) {
      throw new IdempotencyKeyRequiredError();
    }
    const idempotencyResult = IdempotencyKeySchema.safeParse(idempotencyValue);
    if (!idempotencyResult.success) {
      throw invalidHeader(
        "headers.idempotency-key",
        "Idempotency-Key must contain 8 to 255 visible ASCII characters.",
      );
    }

    const ifMatch = singleHeader(request.headers["if-match"]);
    let expectedVersion: number | undefined;
    if (security?.requireIfMatch === true) {
      if (ifMatch === undefined) {
        throw new PreconditionRequiredError();
      }
      const ifMatchResult = ETagSchema.safeParse(ifMatch);
      if (!ifMatchResult.success) {
        throw invalidHeader(
          "headers.if-match",
          "If-Match must be one strong resource ETag.",
        );
      }
      expectedVersion = parseExpectedVersion(ifMatchResult.data);
    } else if (ifMatch !== undefined) {
      const ifMatchResult = ETagSchema.safeParse(ifMatch);
      if (!ifMatchResult.success) {
        throw invalidHeader(
          "headers.if-match",
          "If-Match must be one strong resource ETag.",
        );
      }
      expectedVersion = parseExpectedVersion(ifMatchResult.data);
    }

    const routeTemplate =
      request.routeOptions.url ?? request.url.split("?", 1)[0] ?? request.url;
    request.mutationContext = {
      principal,
      source,
      requestId: request.pihRequestId,
      idempotencyKey: idempotencyResult.data,
      routeTemplate,
      method,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(ifMatch === undefined ? {} : { expectedEtag: ifMatch }),
    };
  });
};
