import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BffRequestError, bffJson } from "./bff-request";

describe("bffJson", () => {
  it("sends same-origin, non-cached, non-redirecting JSON requests", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    await bffJson(fetcher, "/api/ui/v1/x", z.object({ ok: z.boolean() }), { method: "PATCH", body: { a: 1 } });
    expect(fetcher).toHaveBeenCalledWith("/api/ui/v1/x", expect.objectContaining({
      method: "PATCH", body: "{\"a\":1}", credentials: "same-origin", cache: "no-store", redirect: "error",
    }));
  });

  it("keeps only the status and a validated problem code on failure", async () => {
    const problem = { type: "about:blank", title: "Conflict", status: 409, code: "conflict", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957" };
    const failure = await bffJson(vi.fn(async () => Response.json(problem, { status: 409 })), "/x", z.unknown()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BffRequestError);
    expect((failure as BffRequestError).status).toBe(409);
    const opaque = await bffJson(vi.fn(async () => new Response("<html>", { status: 502 })), "/x", z.unknown()).catch((error: unknown) => error);
    expect((opaque as BffRequestError).code).toBeNull();
  });

  it("rejects bodies that do not match the contract", async () => {
    await expect(bffJson(vi.fn(async () => Response.json({ ok: "yes" })), "/x", z.object({ ok: z.boolean() }))).rejects.toThrow();
  });
});
