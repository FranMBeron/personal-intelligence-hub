import "server-only";

import type { ApiProblem } from "@personal-intelligence-hub/contracts";

export class GatewayError extends Error {
  readonly problem: ApiProblem;

  constructor(problem: ApiProblem, cause?: unknown) {
    super(problem.title, { cause });
    this.name = "GatewayError";
    this.problem = problem;
  }
}

export const dependencyUnavailable = (
  source: "Hermes" | "Personal data API",
  requestId: string,
  cause?: unknown,
): GatewayError =>
  new GatewayError(
    {
      type: "about:blank",
      title: "Dependency unavailable",
      status: 503,
      detail: `${source} is temporarily unavailable.`,
      instance: "/api/ui/v1",
      code: "dependency_unavailable",
      requestId,
    },
    cause,
  );
