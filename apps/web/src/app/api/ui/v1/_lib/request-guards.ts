import "server-only";

import {
  ApiProblemSchema,
  OpaqueNonEmptyStringSchema,
  type ApiProblem,
} from "@personal-intelligence-hub/contracts";
import { ZodError, type ZodType } from "zod";

import {
  deriveRequestContext,
  type RequestContext,
  type RequestIdentityAdapter,
} from "../../../../../server/context";
import {
  IdentityConcurrencyLimitError,
  type IdentityConcurrencyLimiter,
} from "../../../../../server/identity-concurrency";
import {
  IdentityRateLimitError,
  type IdentityRateLimiter,
} from "../../../../../server/identity-rate-limit";
import { GatewayError } from "../../../../../server/problems";

export type RouteHandler = (request: Request) => Promise<Response>;
export type ContextualRouteHandler<K extends string> = (
  request: Request,
  context: Readonly<{ params: Promise<Record<K, string>> }>,
) => Promise<Response>;

export type RequestPolicy = Readonly<{
  publicOrigin: string;
  identity: RequestIdentityAdapter;
  maxUploadBodyBytes: number;
  agentConcurrency: IdentityConcurrencyLimiter;
  agentRateLimit: IdentityRateLimiter | null;
}>;

export const problemResponse = (problem: ApiProblem): Response =>
  new Response(JSON.stringify(ApiProblemSchema.parse(problem)), {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": problem.requestId,
    },
  });

export const problem = (
  request: Request,
  context: RequestContext,
  status: number,
  code: ApiProblem["code"],
  title: string,
  detail: string,
  errors?: ApiProblem["errors"],
): ApiProblem => ({
  type: "about:blank",
  title,
  status,
  detail,
  instance: new URL(request.url).pathname,
  code,
  requestId: context.requestId,
  ...(errors === undefined ? {} : { errors }),
});

export const validationProblem = (
  request: Request,
  context: RequestContext,
  error: ZodError,
): ApiProblem =>
  problem(
    request,
    context,
    422,
    "validation_failed",
    "Validation failed",
    "The request does not match the public contract.",
    error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "$" : issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  );

export const requireContext = (
  request: Request,
  policy: RequestPolicy,
): Promise<
  { ok: true; context: RequestContext } | { ok: false; response: Response }
> =>
  deriveRequestContext(request.headers, undefined, policy.identity).then((result) =>
    result.ok
      ? result
      : { ok: false, response: problemResponse(result.problem) },
  );

export const requireEmptyQuery = (
  request: Request,
  context: RequestContext,
): Response | null => {
  const keys = [...new URL(request.url).searchParams.keys()];
  if (keys.length === 0) return null;
  return problemResponse(
    validationProblem(
      request,
      context,
      new ZodError([...new Set(keys)].map((key) => ({
        code: "unrecognized_keys" as const,
        keys: [key],
        path: [],
        message: "Unrecognized query parameter.",
      }))),
    ),
  );
};

export const requireSameOrigin = (
  request: Request,
  context: RequestContext,
  policy: RequestPolicy,
): Response | null => {
  const origin = request.headers.get("origin");
  if (origin !== null && origin === policy.publicOrigin) return null;
  return problemResponse(
    problem(
      request,
      context,
      403,
      "forbidden",
      "Forbidden",
      "State-changing requests must come from the application origin.",
    ),
  );
};

/**
 * A missing gateway means the deployment does not configure that dependency. By default that is reported as
 * 503; `notConfiguredStatus: 501` lets a route tell "not configured" (permanent for this deployment) apart from
 * a configured gateway that is failing (503), while keeping the existing `dependency_unavailable` code.
 */
export const requireGateway = <T>(
  request: Request,
  context: RequestContext,
  gateway: T | null,
  name: string,
  { notConfiguredStatus = 503 }: Readonly<{ notConfiguredStatus?: 501 | 503 }> = {},
): T | Response =>
  gateway ??
  problemResponse(
    problem(
      request,
      context,
      notConfiguredStatus,
      "dependency_unavailable",
      `${name} not configured`,
      `${name} is not configured for this deployment.`,
    ),
  );

export const failureResponse = (
  request: Request,
  context: RequestContext,
  error: unknown,
): Response => {
  if (
    error instanceof IdentityConcurrencyLimitError ||
    error instanceof IdentityRateLimitError
  ) {
    return problemResponse(
      problem(
        request,
        context,
        429,
        "too_many_requests",
        "Too many requests",
        "The configured per-identity concurrency limit was reached.",
      ),
    );
  }
  if (error instanceof PayloadTooLargeError) {
    return problemResponse(
      problem(request, context, 413, "payload_too_large", "Payload too large", error.message),
    );
  }
  if (error instanceof GatewayError) return problemResponse(error.problem);
  if (error instanceof ZodError) return problemResponse(validationProblem(request, context, error));
  return problemResponse(
    problem(
      request,
      context,
      500,
      "internal_error",
      "Internal error",
      "The request could not be completed.",
    ),
  );
};

export const jsonResponse = (value: unknown, requestId: string, status = 200): Response =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });

/** Upper bound for BFF JSON request bodies; every UI command body is far smaller. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("The request body exceeds the configured byte limit.");
    this.name = "PayloadTooLargeError";
  }
}

/** Reads at most `limit` bytes; returns null (after cancelling the body) when exceeded. */
export const readBoundedBody = async (request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Parses a JSON body of at most MAX_JSON_BODY_BYTES; larger bodies raise PayloadTooLargeError (413). */
export const parseJsonBody = async <T>(request: Request, schema: ZodType<T>): Promise<T> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  const bytes = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
  if (bytes === null) throw new PayloadTooLargeError();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ZodError([{ code: "custom", path: [], message: "Expected a valid JSON body." }]);
  }
  return schema.parse(payload);
};

export const parseStrictQuery = <T>(request: Request, schema: ZodType<T>): T => {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key)) {
      throw new ZodError([{ code: "custom", path: [key], message: "Query parameters must not be repeated." }]);
    }
    values[key] = value;
  }
  return schema.parse(values);
};

export const parseResourceId = (value: string): string => OpaqueNonEmptyStringSchema.parse(value);

export const runAgentOperation = <T>(
  context: RequestContext,
  policy: RequestPolicy,
  operation: () => Promise<T>,
): Promise<T> => {
  policy.agentRateLimit?.consume(context.concurrencyKey);
  return policy.agentConcurrency.run(context.concurrencyKey, operation);
};
