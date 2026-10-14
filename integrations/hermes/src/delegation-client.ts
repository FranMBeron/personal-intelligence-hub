import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

import { DelegationSchema, type Delegation } from "@personal-intelligence-hub/contracts";

import { NodeUnixHttpTransport, type UnixHttpTransport } from "./unix-http-transport.js";

/** The only route this client can ever call. */
export const DELEGATION_REQUEST_PATH = "/internal/v1/hermes/delegations";
/**
 * BFF-facing locations the agent-only client must never use: the whole host BFF
 * directory (the same prefix rule the server enforces) and the in-container path.
 */
const FORBIDDEN_SOCKET_DIRECTORY = "/run/pih-connectors/web";
const FORBIDDEN_SOCKET_PATHS: ReadonlySet<string> = new Set(["/run/pih-connectors/connectors.sock"]);
const isForbiddenSocketPath = (path: string): boolean =>
  FORBIDDEN_SOCKET_PATHS.has(path) || path === FORBIDDEN_SOCKET_DIRECTORY || path.startsWith(FORBIDDEN_SOCKET_DIRECTORY + "/");
const TargetIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
const MIN_CREDENTIAL_LENGTH = 32;
const StartSchema = z.object({
  targetAgentId: z.string().min(1).max(64),
  message: z.string().min(1).max(20_000).regex(/\S/u),
  sourceSessionId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).optional(),
}).strict();

export const delegationClientErrorCodes = [
  "delegation_target_unknown",
  "delegation_request_invalid",
  "delegation_response_invalid",
  "delegation_failed",
  "authentication_required",
  "forbidden",
  "validation_failed",
  "idempotency_key_required",
  "idempotency_key_reused",
  "payload_too_large",
  "hermes_upstream_unavailable",
  "hermes_delegation_unavailable",
  "hermes_delegation_target_unavailable",
] as const;
export type DelegationClientErrorCode = (typeof delegationClientErrorCodes)[number];
const knownCodes: ReadonlySet<string> = new Set(delegationClientErrorCodes);

export class DelegationClientError extends Error {
  readonly code: DelegationClientErrorCode;

  constructor(code: DelegationClientErrorCode) {
    super(code);
    this.name = "DelegationClientError";
    this.code = code;
  }
}

const fail = (code: DelegationClientErrorCode): never => { throw new DelegationClientError(code); };

export type DelegationStartInput = Readonly<{ targetAgentId: string; message: string; sourceSessionId?: string }>;
/** Per-call context from the Hermes tool runtime, when it supplies one. */
export type DelegationCallContext = Readonly<{ toolCallId?: string }>;

const TOOL_CALL_ID = /^[\x21-\x7e]{1,200}$/u;

/**
 * Deterministic idempotency key for one logical delegation, so a retried tool
 * call (client timeout, agent retry) replays the same server-side delegation
 * instead of creating a duplicate. With a Hermes tool-call id it keys on that
 * call (scoped by session and target); otherwise on SHA-256 of
 * (source session, target, message). Consequence: identical repeated
 * delegations (same session, target, and message) without a tool-call id
 * dedupe to the first one for as long as the server retains that delegation's
 * idempotency record. The key is a digest and never contains the message.
 */
export const delegationIdempotencyKey = (
  input: Readonly<{ targetAgentId: string; message: string; sourceSessionId?: string | undefined; toolCallId?: string | undefined }>,
): string => {
  const parts = input.toolCallId !== undefined && TOOL_CALL_ID.test(input.toolCallId)
    ? ["tool_call", input.sourceSessionId ?? null, input.targetAgentId, input.toolCallId]
    : ["content", input.sourceSessionId ?? null, input.targetAgentId, input.message];
  return `pihdk-${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
};

/**
 * Narrow peer client: one fixed agent-only Unix socket, one fixed POST route,
 * and one distinct credential per configured target, chosen only after the
 * target ID validates. It cannot address other origins, methods, or paths.
 */
export class ConnectorsDelegationClient {
  readonly #socketPath: string;
  readonly #credentials: ReadonlyMap<string, string>;
  readonly #transport: UnixHttpTransport;

  constructor(options: Readonly<{
    socketPath: string;
    credentialsByTarget: ReadonlyMap<string, string>;
    transport?: UnixHttpTransport;
  }>) {
    const socketPath = options.socketPath;
    if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || !socketPath.endsWith(".sock") || isForbiddenSocketPath(socketPath)) {
      throw new Error("Delegation socket path is invalid");
    }
    if (options.credentialsByTarget.size === 0) throw new Error("Delegation credentials are required");
    const values = new Set<string>();
    for (const [target, credential] of options.credentialsByTarget) {
      if (!TargetIdSchema.safeParse(target).success) throw new Error("Delegation target is invalid");
      if (typeof credential !== "string" || credential.length < MIN_CREDENTIAL_LENGTH || /\s/u.test(credential) || values.has(credential)) {
        throw new Error("Delegation credentials must be distinct and strong");
      }
      values.add(credential);
    }
    this.#socketPath = socketPath;
    this.#credentials = new Map(options.credentialsByTarget);
    this.#transport = options.transport ?? new NodeUnixHttpTransport();
  }

  async start(input: DelegationStartInput, context: DelegationCallContext = {}): Promise<Delegation> {
    const target = TargetIdSchema.safeParse(input?.targetAgentId);
    const credential = target.success ? this.#credentials.get(target.data) : undefined;
    if (credential === undefined) return fail("delegation_target_unknown");
    const parsed = StartSchema.safeParse(input);
    if (!parsed.success) return fail("delegation_request_invalid");
    let response;
    try {
      response = await this.#transport.postJson({
        socketPath: this.#socketPath,
        path: DELEGATION_REQUEST_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "idempotency-key": delegationIdempotencyKey({ ...parsed.data, ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }) }),
        },
        body: JSON.stringify(parsed.data),
      });
    } catch {
      return fail("delegation_failed");
    }
    if (response.status < 200 || response.status >= 300) {
      const code = (response.body as { code?: unknown } | null)?.code;
      return fail(typeof code === "string" && knownCodes.has(code) ? code as DelegationClientErrorCode : "delegation_failed");
    }
    const delegation = DelegationSchema.safeParse(response.body);
    if (!delegation.success || delegation.data.targetAgentId !== parsed.data.targetAgentId) return fail("delegation_response_invalid");
    return delegation.data;
  }
}
