import { ApiProblemSchema } from "@personal-intelligence-hub/contracts";
import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectorProblem,
  installConnectorProblemHandler,
  toConnectorProblem,
} from "./problems.js";

const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";
const apps: ReturnType<typeof fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("connector problems", () => {
  it("normalizes expected foundation failures without reflecting error text", () => {
    const credential = "test-only-secret-service-token";
    const problem = toConnectorProblem(
      new ConnectorProblem("authentication_required", 401, credential),
      requestId,
      "/v1/test",
    );

    expect(problem).toEqual({
      type: "https://pih.example/problems/authentication-required",
      title: "Authentication required",
      status: 401,
      detail: "Valid connector credentials are required.",
      instance: "/v1/test",
      code: "authentication_required",
      requestId,
    });
    expect(JSON.stringify(problem)).not.toContain(credential);
    expect(ApiProblemSchema.parse(problem)).toEqual(problem);
  });

  it("maps an unsupported request media type to a fixed validation problem", () => {
    const error = Object.assign(new Error("Unsupported Media Type: text/private-marker"), {
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    });
    const problem = toConnectorProblem(error, requestId, "/v1/test");
    expect(problem).toMatchObject({ code: "validation_failed", status: 415 });
    expect(JSON.stringify(problem)).not.toContain("private-marker");
  });

  it("maps unknown failures to a non-reflective internal problem", () => {
    const sensitiveClaim = "decoded-claim-that-must-not-leak";
    const problem = toConnectorProblem(
      new Error(sensitiveClaim),
      requestId,
      "/v1/test",
    );

    expect(problem).toMatchObject({
      status: 500,
      code: "internal_error",
      requestId,
    });
    expect(JSON.stringify(problem)).not.toContain(sensitiveClaim);
    expect(ApiProblemSchema.parse(problem)).toEqual(problem);
  });

  it("installs an application/problem+json Fastify error boundary", async () => {
    const app = fastify({ logger: false });
    apps.push(app);
    installConnectorProblemHandler(app, () => requestId);
    app.get("/v1/test", async () => {
      throw new ConnectorProblem("forbidden", 403, "private-claim");
    });

    const response = await app.inject({ method: "GET", url: "/v1/test" });

    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toMatch(
      /^application\/problem\+json/u,
    );
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.json()).toEqual({
      type: "https://pih.example/problems/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "The authenticated connector principal is not allowed.",
      instance: "/v1/test",
      code: "forbidden",
      requestId,
    });
    expect(response.body).not.toContain("private-claim");
  });
});
