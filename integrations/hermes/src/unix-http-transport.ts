import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute } from "node:path";

export type UnixJsonRequest = Readonly<{
  socketPath: string;
  path: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export type UnixJsonResponse = Readonly<{ status: number; body: unknown }>;

export interface UnixHttpTransport {
  postJson(request: UnixJsonRequest): Promise<UnixJsonResponse>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const fail = (code: string): never => { throw new Error(code); };

/**
 * Minimal JSON-over-Unix-socket POST transport built on node:http with a
 * finite deadline and bounded response. It never follows redirects, never
 * falls back to TCP, and never logs headers or bodies.
 */
export class NodeUnixHttpTransport implements UnixHttpTransport {
  readonly #timeoutMs: number;

  constructor(options: Readonly<{ timeoutMs?: number }> = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) fail("delegation_transport_invalid");
  }

  async postJson(input: UnixJsonRequest): Promise<UnixJsonResponse> {
    if (input.method !== "POST" || !isAbsolute(input.socketPath) || !input.path.startsWith("/")) return fail("delegation_transport_invalid");
    let status;
    try {
      status = await lstat(input.socketPath);
    } catch {
      return fail("delegation_transport_unavailable");
    }
    if (!status.isSocket()) return fail("delegation_transport_invalid");

    return new Promise<UnixJsonResponse>((resolve, reject) => {
      let settled = false;
      const settle = (error: Error | null, value?: UnixJsonResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === null) resolve(value!); else reject(error);
      };
      const outgoing = request({
        socketPath: input.socketPath, path: input.path, method: "POST",
        headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) },
      }, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          response.destroy();
          settle(new Error("delegation_redirect_rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            response.destroy();
            settle(new Error("delegation_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => settle(new Error("delegation_transport_unavailable")));
        response.on("end", () => {
          const json = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
          let body: unknown = null;
          try {
            body = json ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))) as unknown : null;
          } catch {
            body = undefined;
          }
          const success = statusCode >= 200 && statusCode < 300;
          if (success && (!json || body === undefined)) { settle(new Error("delegation_response_invalid")); return; }
          settle(null, { status: statusCode, body: body ?? null });
        });
      });
      const timer = setTimeout(() => {
        outgoing.destroy();
        settle(new Error("delegation_timeout"));
      }, this.#timeoutMs);
      outgoing.on("error", () => settle(new Error("delegation_transport_unavailable")));
      outgoing.end(input.body);
    });
  }
}
