import { describe, expect, it } from "vitest";

import { checkServer } from "./connectivity.js";

const origin = new URL("https://hub.example.test");
const connected = { kind: "connected", origin: "https://hub.example.test" };
const unavailable = (reason: string) => ({ kind: "unavailable", origin: "https://hub.example.test", reason });
const responseFetch = (response: Response): typeof fetch => async () => response;

describe("checkServer", () => {
  it("probes only /health with secure request options", async () => {
    let request: { url: string; options: RequestInit | undefined } | undefined;
    const fetch: typeof globalThis.fetch = async (input, options) => {
      request = { url: String(input), options };
      return Response.json({ status: "ok" });
    };
    expect(await checkServer(origin, { fetch, timeoutMs: 1000 })).toEqual(connected);
    expect(request?.url).toBe("https://hub.example.test/health");
    expect(request?.options).toEqual({ method: "GET", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal), headers: { Accept: "application/json" } });
  });

  it("accepts a successful 2xx JSON payload", async () => {
    expect(await checkServer(origin, { fetch: responseFetch(Response.json({ status: "ok" }, { status: 201 })), timeoutMs: 1000 })).toEqual(connected);
  });

  it.each([301, 302, 307, 400, 401, 500])("rejects status %s without exposing its body", async (status) => {
    expect(await checkServer(origin, { fetch: responseFetch(new Response("fixture-private-body", { status })), timeoutMs: 1000 })).toEqual(unavailable("http-error"));
  });

  it("reports network and redirect rejection without diagnostics", async () => {
    const fetch: typeof globalThis.fetch = async () => { throw new TypeError("fixture-private-host redirect diagnostic"); };
    expect(await checkServer(origin, { fetch, timeoutMs: 1000 })).toEqual(unavailable("network-error"));
  });

  it("reports timeout using the request abort signal", async () => {
    const fetch: typeof globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
    expect(await checkServer(origin, { fetch, timeoutMs: 10 })).toEqual(unavailable("timeout"));
  });

  it("rejects non-JSON responses without exposing their content", async () => {
    expect(await checkServer(origin, { fetch: responseFetch(new Response("fixture-private-body")), timeoutMs: 1000 })).toEqual(unavailable("invalid-response"));
  });

  it.each([null, [], {}, { status: "error" }, { status: "ok", token: "fixture-secret" }, "ok", 1])("rejects an inexact health payload %j", async (payload) => {
    expect(await checkServer(origin, { fetch: responseFetch(Response.json(payload)), timeoutMs: 1000 })).toEqual(unavailable("invalid-response"));
  });

  it("reports timeout while consuming the response body", async () => {
    const fetch: typeof globalThis.fetch = async (_input, options) => new Response(new ReadableStream({ start(controller) {
      options?.signal?.addEventListener("abort", () => controller.error(options.signal?.reason), { once: true });
    } }));
    expect(await checkServer(origin, { fetch, timeoutMs: 10 })).toEqual(unavailable("timeout"));
  });
});
