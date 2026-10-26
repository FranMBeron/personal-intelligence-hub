import "server-only";

import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";

export type ConnectorsSocketRequest = Readonly<{
  path: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers: OutgoingHttpHeaders;
  body?: Buffer;
  signal?: AbortSignal;
  timeoutMs: number;
  streaming?: boolean;
}>;

const validatePath = (path: string): void => {
  if (
    !path.startsWith("/v1/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\r") ||
    path.includes("\n") ||
    path.includes("#")
  ) {
    throw new Error("Connector path must be an internal versioned route.");
  }
};

export class ConnectorsSocket {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith("/") || !socketPath.endsWith(".sock")) {
      throw new Error("Connector transport requires a fixed Unix socket path.");
    }
  }

  request({ path, method, headers, body, signal, timeoutMs, streaming = false }: ConnectorsSocketRequest): Promise<IncomingMessage> {
    validatePath(path);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));

    return new Promise((resolve, reject) => {
      let responseReceived = false;
      let settled = false;
      const request = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      const cleanupTimer = () => {
        if (timer !== undefined) clearTimeout(timer);
      };
      const onError = (error: Error) => {
        if (!responseReceived && !settled) {
          settled = true;
          reject(error);
        }
        cleanupTimer();
      };
      const timer = setTimeout(() => {
        request.destroy(new Error("Connector request timed out."));
      }, timeoutMs);

      request.once("error", onError);
      request.once("close", cleanupTimer);
      request.once("response", (response) => {
        responseReceived = true;
        if (streaming) cleanupTimer();
        else {
          response.once("end", cleanupTimer);
          response.once("close", cleanupTimer);
          response.once("error", cleanupTimer);
        }
        settled = true;
        resolve(response);
      });

      if (body === undefined) request.end();
      else request.end(body);
    });
  }
}
