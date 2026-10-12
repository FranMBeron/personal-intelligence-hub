import { describe, expect, it } from "vitest";

import { GatewayError, dependencyUnavailable } from "./problems";

describe("gateway problems", () => {
  it("creates a safe dependency problem without retaining a cause message", () => {
    const error = dependencyUnavailable(
      "Hermes",
      "5af093d0-84f1-4759-a92e-bbe2949ab957",
      new Error("secret-token private-upstream-body"),
    );

    expect(error).toBeInstanceOf(GatewayError);
    expect(error.problem).toMatchObject({
      status: 503,
      code: "dependency_unavailable",
      requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
    });
    expect(JSON.stringify(error.problem)).not.toMatch(/secret-token|private-upstream/u);
    expect(error.cause).toBeInstanceOf(Error);
  });
});
