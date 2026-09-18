import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayError } from "../problems";
import { HttpPersonalDataGateway } from "./http-personal-data-gateway";

const context = {
  authorization: "Bearer delegated-access-token",
  requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
} as const;
const checkedAt = "2026-09-18T12:00:00.000Z";
const snapshot = {
  generatedAt: checkedAt,
  lastSequence: "42",
  boards: [],
  cards: [],
  relations: [],
  tasks: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpPersonalDataGateway", () => {
  it("checks liveness without a principal and never caches the result", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = new HttpPersonalDataGateway({
      baseUrl: "https://api.example.test/base",
      fetcher,
      clock: () => new Date(checkedAt),
    });

    await expect(gateway.health()).resolves.toEqual({
      status: "available",
      checkedAt,
    });
    const request = (fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request;
    expect(request.url).toBe("https://api.example.test/health/live");
    expect(request.cache).toBe("no-store");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards delegated identity and validates the snapshot", async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot));
    const gateway = new HttpPersonalDataGateway({
      baseUrl: "https://api.example.test",
      fetcher,
      clock: () => new Date(checkedAt),
    });

    await expect(gateway.snapshot(context)).resolves.toEqual(snapshot);
    const request = (fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request;
    expect(request.headers.get("authorization")).toBe(context.authorization);
    expect(request.headers.get("x-request-id")).toBe(context.requestId);
  });

  it("maps invalid upstream data to a safe problem", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ private: "secret-token upstream body" }),
    );
    const gateway = new HttpPersonalDataGateway({
      baseUrl: "https://private-api.example.test",
      fetcher,
      clock: () => new Date(checkedAt),
    });

    const failure = gateway.snapshot(context).catch((error: unknown) => error);
    const error = await failure;
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).problem).toMatchObject({
      code: "dependency_unavailable",
      requestId: context.requestId,
    });
    expect(JSON.stringify((error as GatewayError).problem)).not.toMatch(
      /secret-token|private-api/u,
    );
  });

  it("aborts JSON reads after two seconds", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL) =>
        new Promise<Response>((_resolve, reject) => {
          const request = input as Request;
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    const gateway = new HttpPersonalDataGateway({
      baseUrl: "https://api.example.test",
      fetcher: fetcher as typeof fetch,
      clock: () => new Date(checkedAt),
    });

    const expectation = expect(gateway.snapshot(context)).rejects.toBeInstanceOf(
      GatewayError,
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(
      ((fetcher.mock.calls as unknown as [Request][])[0]?.[0] as Request).signal.aborted,
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
  });
});
