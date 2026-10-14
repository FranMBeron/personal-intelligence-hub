import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../context";
import { ConnectorsHttp } from "./connectors-http";

const socketPath = join(tmpdir(), "pih-connectors-socket-" + process.pid + "-" + randomUUID() + ".sock");
const config = { socketPath, serviceToken: "fictional-pih-web-service-token-with-32-bytes", delegatedJwtKey: new Uint8Array(32).fill(3) };
const context: RequestContext = {
  authorization: "Bearer source-auth-not-forwarded",
  concurrencyKey: "test:actor",
  requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:test@example.test", actorType: "human" },
};
const singleHeader = (value: string | string[] | undefined): string | undefined => typeof value === "string" ? value : undefined;
type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;
let server: Server | undefined;

const start = async (handler: RequestListener) => {
  server = createServer(handler);
  server.listen(socketPath);
  await once(server, "listening");
};

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await unlink(socketPath).catch(() => undefined);
});

describe("ConnectorsSocket", () => {
  it("uses only the configured Unix socket and forwards both auth headers to the encoded route", async () => {
    let captured: { url?: string | undefined; service?: string | undefined; authorization?: string | undefined } = {};
    await start((request, response) => {
      captured = { url: request.url, service: singleHeader(request.headers["x-pih-service-token"]), authorization: singleHeader(request.headers.authorization) };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: heartbeat\ndata: {}\n\n");
    });
    const response = await new ConnectorsHttp(config).stream(context, "/v1/conversations/a%2Fb/events", "event-7", new AbortController().signal);
    expect(captured.url).toBe("/v1/conversations/a%2Fb/events");
    expect(captured.service).toBe(config.serviceToken);
    expect(captured.authorization).toMatch(/^Bearer /u);
    expect(captured.authorization).not.toBe(context.authorization);
    expect(await response.text()).toContain("event: heartbeat");
  });

  it("preserves chunked SSE backpressure and keeps the active stream open past the handshake timeout", async () => {
    await start((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: first\ndata: one\n\n");
      setTimeout(() => response.end("event: last\ndata: two\n\n"), 80);
    });
    const response = await new ConnectorsHttp({ ...config, timeoutMs: 25 }).stream(context, "/v1/conversations/a/events", undefined, new AbortController().signal);
    await expect(response.text()).resolves.toContain("event: last");
  });

  it("closes the server-side stream when the caller aborts and removes the abort listener after close", async () => {
    let disconnected = false;
    await start((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: heartbeat\ndata: {}\n\n");
      response.on("close", () => { disconnected = true; });
    });
    const controller = new AbortController();
    const response = await new ConnectorsHttp(config).stream(context, "/v1/conversations/a/events", undefined, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort(new Error("client disconnected"));
    await expect(reader.read()).rejects.toBeDefined();
    await vi.waitFor(() => expect(disconnected).toBe(true));
  });

  it("maps a closed socket to a safe dependency error", async () => {
    const http = new ConnectorsHttp(config);
    await expect(http.stream(context, "/v1/conversations/a/events", undefined, new AbortController().signal)).rejects.toMatchObject({
      problem: { status: 503, code: "dependency_unavailable" },
    });
  });

  it("rejects redirects without following them", async () => {
    await start((_request, response) => {
      response.writeHead(302, { location: "/redirected" });
      response.end();
    });
    const response = await new ConnectorsHttp(config).stream(context, "/v1/conversations/a/events", undefined, new AbortController().signal).catch((error: unknown) => error);
    expect(response).toMatchObject({ problem: { status: 503 } });
  });
});
