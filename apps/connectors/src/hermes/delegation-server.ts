import { chmod, chown as chownPath, link, lstat, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

import { DelegationSchema } from "@personal-intelligence-hub/contracts";

import type { DelegationPeerRegistry } from "./delegation-auth.js";
import { HermesDelegationError, type DelegationService, type HermesDelegationErrorCode } from "./delegation-service.js";

export const DELEGATION_PATH = "/internal/v1/hermes/delegations";
const MAX_BODY_CEILING = 32 * 1024;
const BEARER = /^Bearer ([\x21-\x7e]+)$/u;
/** Shape gate only (unknown fields rejected); the service owns semantic validation. */
const BodySchema = z.object({
  targetAgentId: z.string(),
  message: z.string(),
  sourceSessionId: z.string().optional(),
}).strict();

const statusFor: Readonly<Record<HermesDelegationErrorCode, number>> = {
  forbidden: 403,
  validation_failed: 400,
  idempotency_key_required: 400,
  idempotency_key_reused: 409,
  hermes_delegation_target_unavailable: 503,
  hermes_upstream_unavailable: 503,
  hermes_delegation_unavailable: 503,
  hermes_clock_invalid: 500,
};

type Options = Readonly<{
  socketPath: string;
  socketGroupId: number;
  peers: DelegationPeerRegistry;
  service: Pick<DelegationService, "start">;
  maximumBodyBytes: number;
  /** Group ownership change; injected only by tests that cannot chown. */
  chown?: (path: string, groupId: number) => Promise<void>;
  /**
   * Content-free audit hook for each rejected peer authentication. The event
   * carries only a closed reason, never the presented credential, headers, or body.
   */
  onAuthenticationRejected?: (event: AuthenticationRejected) => void;
}>;

export type AuthenticationRejected = Readonly<{
  event: "hermes_delegation_authentication_rejected";
  reason: "missing_credential" | "unknown_credential";
}>;

class BodyTooLarge extends Error {}

const headerCount = (request: IncomingMessage, name: string): number => {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
};

const readBody = (request: IncomingMessage, maximum: number): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let length = 0;
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (error === undefined) resolve(Buffer.concat(chunks, length)); else reject(error);
  };
  request.on("data", (chunk: Buffer) => {
    if (settled) return;
    length += chunk.byteLength;
    if (length > maximum) { finish(new BodyTooLarge()); return; }
    chunks.push(chunk);
  });
  request.on("end", () => finish());
  request.on("error", () => finish(new Error("request aborted")));
});

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * Agent-only delegation endpoint on a dedicated host Unix socket, built on
 * node:http rather than the BFF Fastify application, so it shares none of the
 * BFF authentication path and exposes exactly one route.
 */
export class HermesDelegationServer {
  readonly #options: Options;
  readonly #chown: (path: string, groupId: number) => Promise<void>;
  #server: Server | undefined;
  #inode: Readonly<{ dev: number; ino: number }> | undefined;
  #rejectedAuthentications = 0;

  constructor(options: Options) {
    if (!Number.isInteger(options.maximumBodyBytes) || options.maximumBodyBytes < 1 || options.maximumBodyBytes > MAX_BODY_CEILING) {
      throw new Error("hermes_delegation_body_limit_invalid");
    }
    this.#options = options;
    this.#chown = options.chown ?? ((path, groupId) => chownPath(path, -1, groupId));
  }

  /** Rejected peer authentications since start (content-free; for health and audit counters). */
  get rejectedAuthentications(): number {
    return this.#rejectedAuthentications;
  }

  /**
   * Bind without any permissive window: listen inside a fresh 0700 staging
   * directory next to the final path, set mode 0660 and the agent group there,
   * then hard-link the secured inode into place (never replacing an existing
   * entry) and remove the staging name. The socket is never reachable at its
   * final path with default permissions, and no process umask is touched.
   */
  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("hermes_delegation_server_started");
    await this.#secureDirectory();
    await this.#clearStaleSocket();
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000, maxHeaderSize: 8_192 }, (request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) this.#respond(response, 500, { code: "internal_error" });
      });
    });
    const staging = await mkdtemp(join(dirname(this.#options.socketPath), ".d-"));
    const stagingSocket = join(staging, "s");
    let staged: Readonly<{ dev: number; ino: number }> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(stagingSocket, () => { server.off("error", reject); resolve(); });
      });
      this.#server = server;
      await chmod(stagingSocket, 0o660);
      await this.#chown(stagingSocket, this.#options.socketGroupId);
      const secured = await lstat(stagingSocket);
      if (!secured.isSocket()) throw new Error("not a socket");
      staged = { dev: secured.dev, ino: secured.ino };
      await link(stagingSocket, this.#options.socketPath);
      this.#inode = staged;
      const status = await lstat(this.#options.socketPath);
      if (!status.isSocket() || status.dev !== staged.dev || status.ino !== staged.ino) throw new Error("replaced");
    } catch {
      // stop() removes the final path only if it is still this process's inode.
      await this.stop();
      throw new Error("hermes_delegation_socket_unsafe");
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Close active requests and remove only the socket inode this process created. Idempotent. */
  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    const inode = this.#inode;
    this.#inode = undefined;
    if (inode === undefined) return;
    try {
      const status = await lstat(this.#options.socketPath);
      if (status.isSocket() && status.dev === inode.dev && status.ino === inode.ino) await unlink(this.#options.socketPath);
    } catch {
      // Already gone or replaced by someone else: never remove a foreign entry.
    }
  }

  /**
   * The socket directory is dedicated to agents: owned by this service, group the agent group,
   * mode 0750, so an agent can traverse it without any access to the service root's other entries.
   * A missing directory is created 0700 and only then handed to the group; a symbolic link, a
   * foreign owner or a replaced inode is refused.
   */
  async #secureDirectory(): Promise<void> {
    const directory = dirname(this.#options.socketPath);
    const uid = process.getuid?.();
    const unsafe = () => new Error("hermes_delegation_socket_unsafe");
    const inspect = async () => {
      try {
        return await lstat(directory);
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw unsafe();
      }
    };
    try {
      let entry = await inspect();
      if (entry === undefined) {
        await mkdir(directory, { mode: 0o700 });
        entry = await inspect();
      }
      if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory() || (uid !== undefined && entry.uid !== uid)) throw unsafe();
      await this.#chown(directory, this.#options.socketGroupId);
      await chmod(directory, 0o750);
      const secured = await inspect();
      if (
        secured === undefined || secured.isSymbolicLink() || !secured.isDirectory() ||
        secured.dev !== entry.dev || secured.ino !== entry.ino || (secured.mode & 0o777) !== 0o750 ||
        // An injected test chown cannot change the group; the real one must have.
        (this.#options.chown === undefined && secured.gid !== this.#options.socketGroupId)
      ) {
        throw unsafe();
      }
    } catch {
      throw unsafe();
    }
  }

  async #clearStaleSocket(): Promise<void> {
    let status;
    try {
      status = await lstat(this.#options.socketPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw new Error("hermes_delegation_socket_unsafe");
    }
    if (!status.isSocket()) throw new Error("hermes_delegation_socket_unsafe");
    const live = await new Promise<boolean>((resolve) => {
      const probe = connect(this.#options.socketPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (live) throw new Error("hermes_delegation_socket_in_use");
    await unlink(this.#options.socketPath);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== DELEGATION_PATH) return this.#reject(request, response, 404, "not_found");
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return this.#reject(request, response, 405, "method_not_allowed");
    }
    if (headerCount(request, "authorization") > 1) return this.#reject(request, response, 400, "validation_failed");
    const credential = BEARER.exec(request.headers.authorization ?? "")?.[1];
    const peer = credential === undefined ? null : this.#options.peers.authenticate(credential);
    if (peer === null) {
      this.#auditRejected(credential === undefined ? "missing_credential" : "unknown_credential");
      return this.#reject(request, response, 401, "authentication_required");
    }
    const mediaType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return this.#reject(request, response, 415, "unsupported_media_type");
    const idempotencyKey = request.headers["idempotency-key"];
    if (headerCount(request, "idempotency-key") !== 1 || typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return this.#reject(request, response, 400, "idempotency_key_required");
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && Number(declared) > this.#options.maximumBodyBytes) {
      return this.#reject(request, response, 413, "payload_too_large");
    }
    let raw: Buffer;
    try {
      raw = await readBody(request, this.#options.maximumBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLarge) return this.#reject(request, response, 413, "payload_too_large");
      return this.#reject(request, response, 400, "validation_failed");
    }
    let body: z.infer<typeof BodySchema>;
    try {
      body = BodySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown);
    } catch {
      return this.#respond(response, 400, { code: "validation_failed" });
    }
    if (body.targetAgentId !== peer.targetAgentId) return this.#respond(response, 403, { code: "forbidden" });
    try {
      const delegation = DelegationSchema.parse(await this.#options.service.start(peer, idempotencyKey, {
        targetAgentId: body.targetAgentId, message: body.message,
        ...(body.sourceSessionId === undefined ? {} : { sourceSessionId: body.sourceSessionId }),
      }));
      this.#respond(response, 201, delegation);
    } catch (error) {
      if (error instanceof HermesDelegationError) return this.#respond(response, statusFor[error.code], { code: error.code });
      this.#respond(response, 500, { code: "internal_error" });
    }
  }

  #auditRejected(reason: AuthenticationRejected["reason"]): void {
    this.#rejectedAuthentications += 1;
    try {
      this.#options.onAuthenticationRejected?.({ event: "hermes_delegation_authentication_rejected", reason });
    } catch {
      // Auditing never changes the response.
    }
  }

  /** Answer before the body is read, then drain (bounded by the request timeout) so the client receives the status. */
  #reject(request: IncomingMessage, response: ServerResponse, status: number, code: string): void {
    response.setHeader("connection", "close");
    this.#respond(response, status, { code });
    request.resume();
  }

  #respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) return;
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    response.end(payload);
  }
}
