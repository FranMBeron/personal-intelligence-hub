import { describe, expect, it } from "vitest";

import { deriveRequestContext } from "./context";

const generatedRequestId = "5af093d0-84f1-4759-a92e-bbe2949ab957";

describe("deriveRequestContext", () => {
  it("uses the configured identity adapter instead of forwarding a browser bearer", async () => {
    const identity = {
      resolve: async () => ({
        ok: true as const,
        authorization: "Bearer signed-internal-identity",
        concurrencyKey: "test:identity",
      }),
    };

    expect(
      await deriveRequestContext(
        new Headers({ authorization: "Bearer forged-browser-token" }),
        () => generatedRequestId,
        identity,
      ),
    ).toEqual({
      ok: true,
      context: {
        authorization: "Bearer signed-internal-identity",
        concurrencyKey: "test:identity",
        requestId: generatedRequestId,
      },
    });
  });

  it("rejects a request without delegated bearer authorization", async () => {
    expect(
      await deriveRequestContext(new Headers(), () => generatedRequestId),
    ).toEqual({
      ok: false,
      problem: expect.objectContaining({
        status: 401,
        code: "authentication_required",
        requestId: generatedRequestId,
      }),
    });
  });

  it("rejects other authorization schemes", async () => {
    expect(
      await deriveRequestContext(
        new Headers({ authorization: "Basic dXNlcjpwYXNz" }),
        () => generatedRequestId,
      ),
    ).toMatchObject({
      ok: false,
      problem: { code: "authentication_required" },
    });
  });

  it("preserves a valid request ID and delegated bearer value", async () => {
    const requestId = "99acb7b5-9dbe-44bf-a590-00824cfd2893";
    expect(
      await deriveRequestContext(
        new Headers({
          authorization: "Bearer delegated-access-token",
          "x-request-id": requestId,
        }),
        () => generatedRequestId,
      ),
    ).toEqual({
      ok: true,
      context: {
        authorization: "Bearer delegated-access-token",
        concurrencyKey: expect.stringMatching(/^oidc:/u),
        requestId,
      },
    });
  });

  it("replaces an invalid external request ID", async () => {
    expect(
      await deriveRequestContext(
        new Headers({
          authorization: "Bearer delegated-access-token",
          "x-request-id": "not-a-uuid",
        }),
        () => generatedRequestId,
      ),
    ).toMatchObject({ ok: true, context: { requestId: generatedRequestId } });
  });
});
