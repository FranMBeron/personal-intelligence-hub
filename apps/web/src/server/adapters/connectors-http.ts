import "server-only";

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  ApiProblemSchema,
  type ApiProblem,
  type ApiProblemCode,
  type ConnectorScope,
  type UploadedMedia,
  UploadedMediaSchema,
} from "@personal-intelligence-hub/contracts";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { z } from "zod";

import type { ConnectorsConfig } from "../../config/server";
import type { RequestContext } from "../context";
import { signConnectorsAuthorization } from "../connectors-authorization";
import { GatewayError, dependencyUnavailable } from "../problems";
import { ConnectorsSocket } from "./connectors-socket";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_JSON_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_UPLOAD_BYTES = 10_485_760;
const ALLOWED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const JSON_CONTENT_TYPES = new Set(["application/json", "application/problem+json"]);

const safeProblemText: Readonly<Record<ApiProblemCode, Readonly<{ title: string; detail: string }>>> = {
  authentication_required: { title: "Authentication required", detail: "The request could not be authenticated." },
  invalid_token: { title: "Authentication required", detail: "The request could not be authenticated." },
  forbidden: { title: "Forbidden", detail: "The request is not allowed." },
  payload_too_large: { title: "Upload too large", detail: "The request exceeds the allowed size." },
  too_many_requests: { title: "Too many requests", detail: "Please wait before trying again." },
  validation_failed: { title: "Invalid request", detail: "The request did not satisfy validation." },
  not_found: { title: "Not found", detail: "The requested item was not found." },
  precondition_required: { title: "Precondition required", detail: "The request requires a current version." },
  version_conflict: { title: "Version conflict", detail: "The item changed. Reload it before trying again." },
  idempotency_key_required: { title: "Idempotency key required", detail: "The request requires an idempotency key." },
  idempotency_key_reused: { title: "Conflict", detail: "The idempotency key was already used for a different request." },
  invalid_cursor: { title: "Invalid cursor", detail: "The requested page cursor is invalid." },
  cursor_expired: { title: "Cursor expired", detail: "The requested page is no longer available." },
  event_cursor_expired: { title: "Event cursor expired", detail: "The event history is no longer available." },
  conflict: { title: "Conflict", detail: "The request conflicts with the current item state." },
  rate_limit_exceeded: { title: "Too many requests", detail: "Please wait before trying again." },
  internal_error: { title: "Dependency unavailable", detail: "The connected service is temporarily unavailable." },
  dependency_unavailable: { title: "Dependency unavailable", detail: "The connected service is temporarily unavailable." },
};

type JsonRequest<T> = Readonly<{
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  schema: z.ZodType<T>;
  body?: unknown;
  scope: ConnectorScope;
  idempotencyKey?: string;
  signal?: AbortSignal | undefined;
}>;

type Options = Pick<ConnectorsConfig, "socketPath" | "serviceToken" | "delegatedJwtKey"> & Readonly<{
  timeoutMs?: number;
  maxUploadBytes?: number;
  maxJsonResponseBytes?: number;
  socket?: ConnectorsSocket;
}>;

const contentType = (response: IncomingMessage): string | undefined => {
  const value = response.headers["content-type"];
  if (typeof value !== "string") return undefined;
  return value.split(";", 1)[0]?.trim().toLowerCase();
};

const collect = async (response: IncomingMessage, maximum: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) {
      response.destroy(new Error("Connector response exceeded its limit."));
      throw new Error("Connector response exceeded its limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
};

const genericProblem = (status: number, code: ApiProblemCode, requestId: string): ApiProblem => {
  const safe = safeProblemText[code];
  return {
    type: "about:blank",
    title: safe.title,
    status,
    detail: safe.detail,
    instance: "/api/ui/v1",
    code,
    requestId,
  };
};

export class ConnectorsHttp {
  readonly #serviceToken: string;
  readonly #configuration: Pick<ConnectorsConfig, "delegatedJwtKey">;
  readonly #socket: ConnectorsSocket;
  readonly #timeoutMs: number;
  readonly #maxUploadBytes: number;
  readonly #maxJsonResponseBytes: number;

  constructor(options: Options) {
    this.#serviceToken = options.serviceToken;
    this.#configuration = { delegatedJwtKey: options.delegatedJwtKey };
    this.#socket = options.socket ?? new ConnectorsSocket(options.socketPath);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    this.#maxJsonResponseBytes = options.maxJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES;
  }

  async #headers(context: RequestContext, scope: ConnectorScope): Promise<OutgoingHttpHeaders> {
    if (context.principal === undefined) {
      throw new GatewayError({
        type: "about:blank",
        title: "Authentication required",
        status: 401,
        detail: "A verified human identity is required for private connector requests.",
        instance: "/api/ui/v1",
        code: "authentication_required",
        requestId: context.requestId,
      });
    }
    const delegatedAuthorization = await signConnectorsAuthorization(
      context.principal,
      context.requestId,
      [scope],
      this.#configuration,
    );
    return {
      accept: "application/json",
      authorization: delegatedAuthorization,
      "x-pih-service-token": this.#serviceToken,
      "x-request-id": context.requestId,
    };
  }

  async #error(response: IncomingMessage, context: RequestContext): Promise<GatewayError> {
    if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
      response.destroy();
      return dependencyUnavailable("Connectors", context.requestId);
    }
    try {
      if (!JSON_CONTENT_TYPES.has(contentType(response) ?? "")) throw new Error("Unexpected connector error content type.");
      const payload: unknown = JSON.parse((await collect(response, this.#maxJsonResponseBytes)).toString("utf8"));
      const parsed = ApiProblemSchema.safeParse(payload);
      if (!parsed.success || parsed.data.status !== response.statusCode) throw new Error("Invalid connector problem.");
      const problem = genericProblem(response.statusCode ?? 503, parsed.data.code, context.requestId);
      return new GatewayError(problem);
    } catch (error) {
      if (error instanceof GatewayError) return error;
      return dependencyUnavailable("Connectors", context.requestId, error);
    }
  }

  async #readJson<T>(response: IncomingMessage, schema: z.ZodType<T>, context: RequestContext): Promise<T> {
    if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
      throw await this.#error(response, context);
    }
    if (!JSON_CONTENT_TYPES.has(contentType(response) ?? "")) {
      response.destroy();
      throw dependencyUnavailable("Connectors", context.requestId);
    }
    try {
      const payload: unknown = JSON.parse((await collect(response, this.#maxJsonResponseBytes)).toString("utf8"));
      return schema.parse(payload);
    } catch (error) {
      throw dependencyUnavailable("Connectors", context.requestId, error);
    }
  }

  async json<T>(context: RequestContext, request: JsonRequest<T>): Promise<T> {
    try {
      const headers = await this.#headers(context, request.scope);
      if (request.body !== undefined) headers["content-type"] = "application/json";
      if (request.idempotencyKey !== undefined) {
        if (request.idempotencyKey.trim() === "" || /[\r\n]/u.test(request.idempotencyKey)) {
          throw new Error("Invalid idempotency key.");
        }
        headers["idempotency-key"] = request.idempotencyKey;
      }
      const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), "utf8");
      const response = await this.#socket.request({
        path: request.path,
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timeoutMs: this.#timeoutMs,
      });
      return await this.#readJson(response, request.schema, context);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Connectors", context.requestId, error);
    }
  }

  async stream(
    context: RequestContext,
    path: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      const headers = await this.#headers(context, "hermes:conversations:read");
      headers.accept = "text/event-stream";
      if (cursor !== undefined) {
        if (cursor.trim() === "" || /[\r\n]/u.test(cursor)) throw new Error("Invalid event cursor.");
        headers["last-event-id"] = cursor;
      }
      const response = await this.#socket.request({
        path,
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.#timeoutMs,
        streaming: true,
      });
      if (response.statusCode !== 200) throw await this.#error(response, context);
      if (contentType(response) !== "text/event-stream") {
        response.destroy();
        throw dependencyUnavailable("Connectors", context.requestId);
      }
      return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Connectors", context.requestId, error);
    }
  }

  async multipart<T>(
    context: RequestContext,
    options: Readonly<{
      path: string;
      scope: ConnectorScope;
      fields: Readonly<Record<string, string>>;
      file: File;
      schema: z.ZodType<T>;
      signal?: AbortSignal;
    }>,
  ): Promise<T> {
    try {
      if (!ALLOWED_UPLOAD_TYPES.has(options.file.type)) {
        throw new GatewayError({
          type: "about:blank", title: "Invalid upload", status: 422,
          detail: "Only supported image attachments can be uploaded.", instance: "/api/ui/v1",
          code: "validation_failed", requestId: context.requestId,
        });
      }
      if (options.file.size > this.#maxUploadBytes) {
        throw new GatewayError({
          type: "about:blank", title: "Upload too large", status: 413,
          detail: "The upload exceeds the allowed size.", instance: "/api/ui/v1",
          code: "payload_too_large", requestId: context.requestId,
        });
      }
      const fileBytes = Buffer.from(await options.file.arrayBuffer());
      if (fileBytes.byteLength > this.#maxUploadBytes) throw new Error("Upload exceeded its configured limit.");
      const boundary = "pih-connectors-" + randomUUID();
      const parts: Buffer[] = [];
      for (const [name, value] of Object.entries(options.fields)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name) || /[\r\n]/u.test(value)) throw new Error("Invalid multipart field.");
        parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n", "utf8"));
      }
      const filename = options.file.name.replace(/[\r\n"]/gu, "_").slice(0, 255);
      parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"media\"; filename=\"" + filename + "\"\r\nContent-Type: " + options.file.type + "\r\n\r\n", "utf8"));
      parts.push(fileBytes, Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"));
      const body = Buffer.concat(parts);
      if (body.byteLength > this.#maxUploadBytes + 16_384) throw new Error("Multipart upload exceeded its configured limit.");
      const headers = await this.#headers(context, options.scope);
      headers["content-type"] = "multipart/form-data; boundary=" + boundary;
      headers["content-length"] = body.byteLength;
      const response = await this.#socket.request({
        path: options.path,
        method: "POST",
        headers,
        body,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: this.#timeoutMs,
      });
      return await this.#readJson(response, options.schema, context);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Connectors", context.requestId, error);
    }
  }

  upload(
    context: RequestContext,
    conversationId: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<UploadedMedia> {
    return this.multipart(context, {
      path: "/v1/uploads",
      scope: "hermes:conversations:write",
      fields: { conversationId, kind: "attachment" },
      file,
      schema: UploadedMediaSchema,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
