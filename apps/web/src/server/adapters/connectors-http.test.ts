import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, webcrypto } from "node:crypto";

import { jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiProblemSchema,
  ConversationSelectionSchema,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import { GatewayError } from "../problems";
import { ConnectorsHttp } from "./connectors-http";

const key = new Uint8Array(32).fill(19);
const configuration = {
  socketPath: join(tmpdir(), "pih-connectors-" + process.pid + "-" + randomUUID() + ".sock"),
  serviceToken: "fictional-pih-web-service-token-with-32-bytes",
  delegatedJwtKey: key,
};
const context: RequestContext = {
  authorization: "Bearer second-brain-token-is-not-forwarded",
  concurrencyKey: "oidc:fictional",
  requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
  principal: {
    actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea",
    subject: "user:fictional@example.test",
    actorType: "human",
  },
};
const selected = {
  agentId: "agent/opaque",
  conversationId: "conversation-01",
  version: 2,
  updatedAt: "2026-10-12T12:00:00.000Z",
};
const singleHeader = (value: string | string[] | undefined): string | undefined => typeof value === "string" ? value : undefined;
type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];

const listen = async (handler: RequestListener): Promise<Server> => {
  const server = createServer(handler);
  servers.push(server);
  server.listen(configuration.socketPath);
  await once(server, "listening");
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await unlink(configuration.socketPath).catch(() => undefined);
});

describe("ConnectorsHttp", () => {
  it("uses separate service and delegated credentials and validates JSON on the fixed Unix socket", async () => {
    let seen: { url?: string | undefined; service?: string | undefined; authorization?: string | undefined; requestId?: string | undefined; body?: string } = {};
    await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen = {
          url: request.url,
          service: singleHeader(request.headers["x-pih-service-token"]),
          authorization: singleHeader(request.headers.authorization),
          requestId: singleHeader(request.headers["x-request-id"]),
          body: Buffer.concat(chunks).toString("utf8"),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(selected));
      });
    });
    const http = new ConnectorsHttp(configuration);
    await expect(http.json(context, {
      path: "/v1/agents/agent%2Fopaque/conversation-selection",
      method: "PUT",
      schema: ConversationSelectionSchema,
      body: { conversationId: "conversation-01", expectedVersion: 2 },
      scope: "hermes:conversations:write",
    })).resolves.toEqual(selected);
    expect(seen).toMatchObject({
      url: "/v1/agents/agent%2Fopaque/conversation-selection",
      service: configuration.serviceToken,
      requestId: context.requestId,
      body: JSON.stringify({ conversationId: "conversation-01", expectedVersion: 2 }),
    });
    expect(seen.authorization).toMatch(/^Bearer /u);
    expect(seen.authorization).not.toBe(context.authorization);
    const verifyKey = await webcrypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const { payload } = await jwtVerify(seen.authorization!.slice("Bearer ".length), verifyKey, {
      issuer: "personal-intelligence-hub-web",
      audience: "personal-intelligence-hub-connectors",
      algorithms: ["HS256"],
    });
    expect(payload).toMatchObject({ actor_id: context.principal?.actorId, request_id: context.requestId, scope: ["hermes:conversations:write"] });
  });

  it.each([
    { status: 409, code: "version_conflict" },
    { status: 410, code: "event_cursor_expired" },
    { status: 422, code: "validation_failed" },
  ])("preserves validated public problem status without forwarding private detail", async ({ status, code }) => {
    await listen((_request, response) => {
      response.writeHead(status, { "content-type": "application/problem+json" });
      response.end(JSON.stringify(ApiProblemSchema.parse({
        type: "about:blank",
        title: "Private connector internals",
        status,
        detail: configuration.serviceToken + " private provider payload",
        instance: "/v1/private/path",
        code,
        requestId: context.requestId,
      })));
    });
    const error = await new ConnectorsHttp(configuration).json(context, {
      path: "/v1/test",
      method: "GET",
      schema: ConversationSelectionSchema,
      scope: "hermes:conversations:read",
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).problem).toMatchObject({ status, code, requestId: context.requestId });
    expect(JSON.stringify((error as GatewayError).problem)).not.toMatch(/private provider payload|Private connector internals|\/v1\/private|fictional-pih-web-service/u);
  });

  it("normalizes malformed upstream errors and rejects redirects", async () => {
    await listen((_request, response) => {
      response.writeHead(302, { location: "http://attacker.example.test/" });
      response.end(JSON.stringify({ private: "payload" }));
    });
    await expect(new ConnectorsHttp(configuration).json(context, {
      path: "/v1/test", method: "GET", schema: ConversationSelectionSchema, scope: "system:read",
    })).rejects.toMatchObject({ problem: { status: 503, code: "dependency_unavailable" } });
  });

  it("bounds JSON response size and rejects a successful non-JSON response", async () => {
    await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("not-json");
    });
    await expect(new ConnectorsHttp(configuration).json(context, {
      path: "/v1/test", method: "GET", schema: ConversationSelectionSchema, scope: "system:read",
    })).rejects.toMatchObject({ problem: { status: 503, code: "dependency_unavailable" } });
  });

  it("rejects JSON responses over the configured byte limit", async () => {
    await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ conversationId: "a", agentId: "b", version: 1, updatedAt: "2026-10-12T12:00:00.000Z", padding: "x".repeat(100) }));
    });
    await expect(new ConnectorsHttp({ ...configuration, maxJsonResponseBytes: 32 }).json(context, {
      path: "/v1/test", method: "GET", schema: ConversationSelectionSchema, scope: "system:read",
    })).rejects.toMatchObject({ problem: { status: 503, code: "dependency_unavailable" } });
  });

  it("bounds multipart uploads, allows image MIME types, and validates the receipt", async () => {
    let uploadRequest: { contentType?: string | undefined; body?: string | undefined } = {};
    await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const type = request.headers["content-type"];
        uploadRequest = { contentType: typeof type === "string" ? type : undefined, body: Buffer.concat(chunks).toString("utf8") };
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ reference: "opaque-image", kind: "attachment", name: "photo.png", mimeType: "image/png", size: 5, expiresAt: "2026-10-12T12:00:00.000Z" }));
      });
    });
    const http = new ConnectorsHttp({ ...configuration, maxUploadBytes: 32 });
    await expect(http.upload(context, "conversation-01", new File(["image"], "photo.png", { type: "image/png" }))).resolves.toMatchObject({ reference: "opaque-image" });
    expect(uploadRequest.contentType?.startsWith("multipart/form-data; boundary=pih-connectors-")).toBe(true);
    expect(uploadRequest.body).toContain("name=\"conversationId\"");
    expect(uploadRequest.body).toContain("conversation-01");
    await expect(http.upload(context, "conversation-01", new File(["x".repeat(33)], "large.png", { type: "image/png" }))).rejects.toMatchObject({ problem: { status: 413, code: "payload_too_large" } });
    await expect(http.upload(context, "conversation-01", new File(["data"], "private.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ problem: { status: 422, code: "validation_failed" } });
  });

  it("aborts a stalled JSON response at its absolute deadline", async () => {
    await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
    });
    const http = new ConnectorsHttp({ ...configuration, timeoutMs: 40 });
    await expect(http.json(context, {
      path: "/v1/test", method: "GET", schema: ConversationSelectionSchema, scope: "system:read",
    })).rejects.toMatchObject({ problem: { status: 503 } });
  });

  it("links caller abort to the in-flight Unix socket request", async () => {
    await listen((request, response) => {
      request.on("close", () => response.destroy());
      response.writeHead(200, { "content-type": "application/json" });
    });
    const controller = new AbortController();
    const pending = new ConnectorsHttp(configuration).json(context, {
      path: "/v1/test", method: "GET", schema: ConversationSelectionSchema, scope: "system:read", signal: controller.signal,
    });
    controller.abort(new Error("client disconnected"));
    await expect(pending).rejects.toBeInstanceOf(GatewayError);
  });
});
