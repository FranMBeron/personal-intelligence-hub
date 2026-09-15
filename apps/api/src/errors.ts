import type {
  ApiProblem,
  ApiProblemCode,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  ApplicationError,
  ValidationError,
  type ProblemValidationError,
} from "./application/errors.js";

type ProblemDefinition = Readonly<{
  status: number;
  title: string;
  detail: string;
}>;

const problems: Readonly<Record<ApiProblemCode, ProblemDefinition>> = {
  authentication_required: {
    status: 401,
    title: "Authentication required",
    detail: "A bearer token is required.",
  },
  invalid_token: {
    status: 401,
    title: "Invalid token",
    detail: "The bearer token is invalid or expired.",
  },
  forbidden: {
    status: 403,
    title: "Forbidden",
    detail:
      "The authenticated principal is not allowed to perform this operation.",
  },
  validation_failed: {
    status: 422,
    title: "Validation failed",
    detail: "The request contains invalid values.",
  },
  not_found: {
    status: 404,
    title: "Resource not found",
    detail: "The requested resource does not exist.",
  },
  precondition_required: {
    status: 428,
    title: "Precondition required",
    detail: "A valid If-Match header is required.",
  },
  version_conflict: {
    status: 412,
    title: "Version conflict",
    detail: "The resource has changed since it was read.",
  },
  idempotency_key_required: {
    status: 400,
    title: "Idempotency key required",
    detail: "A valid Idempotency-Key header is required.",
  },
  idempotency_key_reused: {
    status: 409,
    title: "Idempotency key reused",
    detail: "The idempotency key was already used for a different request.",
  },
  invalid_cursor: {
    status: 400,
    title: "Invalid cursor",
    detail: "The cursor is invalid for this request.",
  },
  cursor_expired: {
    status: 409,
    title: "Cursor expired",
    detail: "The cursor is older than the retained event history.",
  },
  conflict: {
    status: 409,
    title: "Conflict",
    detail: "The operation conflicts with the current resource state.",
  },
  internal_error: {
    status: 500,
    title: "Internal server error",
    detail: "The server could not complete the request.",
  },
  dependency_unavailable: {
    status: 503,
    title: "Dependency unavailable",
    detail: "A required dependency is unavailable.",
  },
};

const sensitiveKey =
  /^(?:authorization|cookie|set-cookie|.*(?:secret|password|token|api[_-]?key|signingkey|databaseurl).*)$/iu;

const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const redacted = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[Redacted]" : redactValue(item, seen),
    ]),
  );
  seen.delete(value);
  return redacted;
};

export const redactForLogging = (value: unknown): unknown =>
  redactValue(value, new WeakSet<object>());

const zodErrors = (error: ZodError): ProblemValidationError[] =>
  error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "request" : issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const fastifyValidationErrors = (error: unknown): ProblemValidationError[] => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("validation" in error) ||
    !Array.isArray(error.validation)
  ) {
    return [];
  }
  return error.validation.map((item: unknown) => {
    const validation =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)
        : {};
    return {
      path:
        typeof validation.instancePath === "string" &&
        validation.instancePath.length > 0
          ? validation.instancePath.replace(/^\//u, "").replaceAll("/", ".")
          : "request",
      message:
        typeof validation.message === "string"
          ? validation.message
          : "The value is invalid.",
      code:
        typeof validation.keyword === "string"
          ? validation.keyword
          : "invalid_value",
    };
  });
};

const normalizeError = (error: unknown): ApplicationError => {
  if (error instanceof ApplicationError) {
    return error;
  }
  if (error instanceof ZodError) {
    return new ValidationError(zodErrors(error));
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  ) {
    return new ValidationError([
      {
        path: "body",
        message: "The request body must contain valid JSON.",
        code: "invalid_json",
      },
    ]);
  }
  const validationErrors = fastifyValidationErrors(error);
  if (validationErrors.length > 0) {
    return new ValidationError(validationErrors);
  }
  return new ApplicationError("internal_error", { cause: error });
};

export const toApiProblem = (
  error: unknown,
  requestId: string,
  instance: string,
): ApiProblem => {
  const normalized = normalizeError(error);
  const definition = problems[normalized.code];
  return {
    type: `https://pih.example/problems/${normalized.code.replaceAll("_", "-")}`,
    title: definition.title,
    status: definition.status,
    detail: definition.detail,
    instance,
    code: normalized.code,
    requestId,
    ...(normalized.validationErrors === undefined
      ? {}
      : { errors: [...normalized.validationErrors] }),
  };
};

const sendProblem = (
  reply: FastifyReply,
  problem: ApiProblem,
  error: unknown,
): void => {
  const normalized = normalizeError(error);
  if (normalized.currentEtag !== undefined) {
    void reply.header("etag", normalized.currentEtag);
  }
  void reply
    .status(problem.status)
    .type("application/problem+json")
    .send(problem);
};

export const installErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error, request, reply) => {
    const requestWithContext = request as FastifyRequest & {
      pihRequestId?: string;
    };
    const requestId = requestWithContext.pihRequestId ?? request.id;
    const problem = toApiProblem(error, requestId, request.url);
    if (problem.status >= 500) {
      const errorRecord =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)
          : {};
      request.log.error(
        redactForLogging({
          error: {
            name:
              typeof errorRecord.name === "string"
                ? errorRecord.name
                : "UnknownError",
            message:
              typeof errorRecord.message === "string"
                ? errorRecord.message
                : "An unknown error occurred.",
            stack:
              typeof errorRecord.stack === "string" ? errorRecord.stack : undefined,
          },
          requestId,
        }),
        "Request failed",
      );
    }
    sendProblem(reply, problem, error);
  });
};
