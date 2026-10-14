import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DELEGATION_TIMEOUT_MS, NodeUnixHttpTransport } from "./unix-http-transport.js";

const servers: Server[] = [];
const directories: string[] = [];

const listen = async (handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) => {
  const directory = await mkdtemp(join(tmpdir(), "pih-unix-transport-"));
  directories.push(directory);
  const socketPath = join(directory, "agent.sock");
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, directory };
};

const request = (socketPath: string) => ({
  socketPath, path: "/internal/v1/hermes/delegations", method: "POST" as const,
  headers: { authorization: "Bearer fictional-token", "content-type": "application/json" }, body: "{\"a\":1}",
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("NodeUnixHttpTransport", () => {
  it("posts JSON over the Unix socket with the fixed method and returns the parsed body", async () => {
    let seen: Record<string, string | undefined> = {};
    const { socketPath } = await listen((incoming, response, body) => {
      seen = { method: incoming.method, url: incoming.url, body, authorization: incoming.headers.authorization };
      response.writeHead(201, { "content-type": "application/json" }).end("{\"ok\":true}");
    });
    const result = await new NodeUnixHttpTransport().postJson(request(socketPath));
    expect(result).toEqual({ status: 201, body: { ok: true } });
    expect(seen).toEqual({ method: "POST", url: "/internal/v1/hermes/delegations", body: "{\"a\":1}", authorization: "Bearer fictional-token" });
  });

  it("returns a JSON error body for non-success statuses", async () => {
    const { socketPath } = await listen((_incoming, response) => {
      response.writeHead(403, { "content-type": "application/json" }).end("{\"code\":\"forbidden\"}");
    });
    await expect(new NodeUnixHttpTransport().postJson(request(socketPath))).resolves.toEqual({ status: 403, body: { code: "forbidden" } });
  });

  it("rejects relative, missing, and non-socket paths before connecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-unix-transport-"));
    directories.push(directory);
    const file = join(directory, "plain.sock");
    await writeFile(file, "not a socket");
    const transport = new NodeUnixHttpTransport();
    await expect(transport.postJson(request("relative/agent.sock"))).rejects.toThrow("delegation_transport_invalid");
    await expect(transport.postJson(request(join(directory, "missing.sock")))).rejects.toThrow("delegation_transport_unavailable");
    await expect(transport.postJson(request(file))).rejects.toThrow("delegation_transport_invalid");
    await expect(transport.postJson({ ...request(file), method: "GET" as never })).rejects.toThrow("delegation_transport_invalid");
  });

  it("rejects redirects, oversized responses, and non-JSON success bodies", async () => {
    const redirect = await listen((_incoming, response) => { response.writeHead(307, { location: "http://127.0.0.1:1/" }).end(); });
    await expect(new NodeUnixHttpTransport().postJson(request(redirect.socketPath))).rejects.toThrow("delegation_redirect_rejected");
    const large = await listen((_incoming, response) => {
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ value: "x".repeat(1024 * 1024) }));
    });
    await expect(new NodeUnixHttpTransport().postJson(request(large.socketPath))).rejects.toThrow("delegation_response_too_large");
    const html = await listen((_incoming, response) => { response.writeHead(201, { "content-type": "text/html" }).end("<b>hi</b>"); });
    await expect(new NodeUnixHttpTransport().postJson(request(html.socketPath))).rejects.toThrow("delegation_response_invalid");
    const broken = await listen((_incoming, response) => { response.writeHead(201, { "content-type": "application/json" }).end("{"); });
    await expect(new NodeUnixHttpTransport().postJson(request(broken.socketPath))).rejects.toThrow("delegation_response_invalid");
  });

  it("times out a stalled server with a finite deadline", async () => {
    const { socketPath } = await listen(() => undefined);
    await expect(new NodeUnixHttpTransport({ timeoutMs: 50 }).postJson(request(socketPath))).rejects.toThrow("delegation_timeout");
  });

  it("waits longer by default than the server's worst-case delegation path", () => {
    // Server: three sequential upstream calls at 5s each (Bot Chat create, recover, run) plus a 15s request timeout.
    expect(DEFAULT_DELEGATION_TIMEOUT_MS).toBeGreaterThan(3 * 5_000);
    expect(DEFAULT_DELEGATION_TIMEOUT_MS).toBeGreaterThan(15_000);
  });
});
