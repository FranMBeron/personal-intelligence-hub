import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

import { DelegationSchema, type Delegation } from "@personal-intelligence-hub/contracts";

import { NodeUnixHttpTransport, type UnixHttpTransport } from "./unix-http-transport.js";

/** The only route this client can ever call. */
export const DELEGATION_REQUEST_PATH = "/internal/v1/hermes/delegations";
/** BFF-facing socket paths (host and in-container); the agent-only client must never use them. */
const FORBIDDEN_SOCKET_PATHS: ReadonlySet<string> = new Set([
  "/run/pih-connectors/web/connectors.sock",
  "/run/pih-connectors/connectors.sock",
]);
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

/**
 * Narrow peer client: one fixed agent-only Unix socket, one fixed POST route,
 * and one distinct credential per configured target, chosen only after the
 * target ID validates. It cannot address other origins, methods, or paths.
 */
export class ConnectorsDelegationClient {
  readonly #socketPath: string;
  readonly #credentials: ReadonlyMap<string, string>;
  readonly #transport: UnixHttpTransport;
  readonly #idempotencyKeyFactory: () => string;

  constructor(options: Readonly<{
    socketPath: string;
    credentialsByTarget: ReadonlyMap<string, string>;
    transport?: UnixHttpTransport;
    idempotencyKeyFactory: () => string;
  }>) {
    const socketPath = options.socketPath;
    if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || !socketPath.endsWith(".sock") || FORBIDDEN_SOCKET_PATHS.has(socketPath)) {
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
    this.#idempotencyKeyFactory = options.idempotencyKeyFactory;
  }

  async start(input: DelegationStartInput): Promise<Delegation> {
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
          "idempotency-key": this.#idempotencyKeyFactory(),
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
