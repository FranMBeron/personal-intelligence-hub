import type {
  ApiProblem,
  ApiProblemCode,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

type FoundationProblemCode = Extract<
  ApiProblemCode,
  | "authentication_required"
  | "forbidden"
  | "rate_limit_exceeded"
  | "internal_error"
>;

type ProblemDefinition = Readonly<{
  title: string;
  detail: string;
}>;

const definitions: Readonly<Record<FoundationProblemCode, ProblemDefinition>> = {
  authentication_required: {
    title: "Authentication required",
    detail: "Valid connector credentials are required.",
  },
  forbidden: {
    title: "Forbidden",
    detail: "The authenticated connector principal is not allowed.",
  },
  rate_limit_exceeded: {
    title: "Rate limit exceeded",
    detail: "The connector request rate limit was exceeded.",
  },
  internal_error: {
    title: "Internal server error",
    detail: "The connector could not complete the request.",
  },
};

export class ConnectorProblem extends Error {
  readonly code: Exclude<FoundationProblemCode, "internal_error">;
  readonly status: 401 | 403 | 429;

  constructor(
    code: Exclude<FoundationProblemCode, "internal_error">,
    status: 401 | 403 | 429,
    message: string = code,
  ) {
    super(message);
    this.name = "ConnectorProblem";
    this.code = code;
    this.status = status;
  }
}

export const toConnectorProblem = (
  error: unknown,
  requestId: string,
  instance: string,
): ApiProblem => {
  const code: FoundationProblemCode =
    error instanceof ConnectorProblem ? error.code : "internal_error";
  const status = error instanceof ConnectorProblem ? error.status : 500;
  const definition = definitions[code];
  return {
    type: `https://pih.example/problems/${code.replaceAll("_", "-")}`,
    title: definition.title,
    status,
    detail: definition.detail,
    instance,
    code,
    requestId,
  };
};

export const installConnectorProblemHandler = (
  app: FastifyInstance,
  requestIdFactory: () => string = randomUUID,
): void => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = requestIdFactory();
    const instance = request.routeOptions.url ?? "/unmatched";
    const problem = toConnectorProblem(error, requestId, instance);
    if (problem.status >= 500) {
      request.log.error(
        { code: problem.code, requestId },
        "Connector request failed",
      );
    }
    void reply
      .status(problem.status)
      .header("x-request-id", requestId)
      .type("application/problem+json")
      .send(problem);
  });
};
