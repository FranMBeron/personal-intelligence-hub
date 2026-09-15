import { describe, expect, it } from "vitest";

import { ApiProblemSchema } from "./errors.js";

const requestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";

describe("API problem contract", () => {
  it("parses the uniform RFC 9457-compatible problem envelope", () => {
    const problem = {
      type: "https://pih.example/problems/validation-failed",
      title: "Validation failed",
      status: 422,
      detail: "The request contains invalid values.",
      instance: "/v1/cards",
      code: "validation_failed",
      requestId,
      errors: [
        {
          path: "title",
          message: "Title is required.",
          code: "too_small",
        },
      ],
    };

    expect(ApiProblemSchema.parse(problem)).toEqual(problem);
    expect(ApiProblemSchema.parse(problem).requestId).toBe(requestId);
  });

  it("rejects undocumented problem codes", () => {
    expect(() =>
      ApiProblemSchema.parse({
        type: "about:blank",
        title: "Nope",
        status: 400,
        detail: "Undocumented error.",
        instance: "/v1/cards",
        code: "bad_request",
        requestId,
      }),
    ).toThrow();
  });

  it("rejects malformed statuses and request identifiers", () => {
    expect(() =>
      ApiProblemSchema.parse({
        type: "about:blank",
        title: "Invalid token",
        status: 200,
        detail: "Not an error status.",
        instance: "/v1/cards",
        code: "invalid_token",
        requestId: "not-a-uuid",
      }),
    ).toThrow();
  });
});
