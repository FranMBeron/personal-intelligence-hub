import type { ApiProblem, ApiProblemCode } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import { toConnectorProblem } from "../../foundation/problems.js";
import { HermesConversationError } from "../conversation-service.js";
import { HermesEventStreamError } from "../event-stream.js";
import { HermesMessageError } from "../message-service.js";
import { HermesUploadError } from "../upload-service.js";

/** Route-level Hermes failures. The message is always the code, never request or provider content. */
export class HermesRouteError extends Error {
  readonly code: string;

  constructor(code: HermesRouteCode) {
    super(code);
    this.name = "HermesRouteError";
    this.code = code;
  }
}

export type HermesRouteCode =
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "idempotency_key_required"
  | "invalid_cursor"
  | "payload_too_large"
  | "too_many_requests"
  | "hermes_images_disabled"
  | "hermes_upload_unavailable"
  | "hermes_delegations_unavailable";

export const routeFail = (code: HermesRouteCode): never => { throw new HermesRouteError(code); };

type Mapped = Readonly<{ status: number; code: ApiProblemCode }>;

const VALIDATION: Mapped = { status: 400, code: "validation_failed" };
const INVALID_CURSOR: Mapped = { status: 400, code: "invalid_cursor" };
const FORBIDDEN: Mapped = { status: 403, code: "forbidden" };
const NOT_FOUND: Mapped = { status: 404, code: "not_found" };
const CONFLICT: Mapped = { status: 409, code: "conflict" };
const BAD_GATEWAY: Mapped = { status: 502, code: "dependency_unavailable" };
const UNAVAILABLE: Mapped = { status: 503, code: "dependency_unavailable" };
const INTERNAL: Mapped = { status: 500, code: "internal_error" };

/**
 * Closed mapping from typed Hermes service and route codes to public problems.
 * Only the contract code, its fixed text, and the status reach the caller; an
 * unlisted code (or any untyped error) becomes an internal error.
 */
const HERMES_PROBLEMS: ReadonlyMap<string, Mapped> = new Map<string, Mapped>([
  ["forbidden", FORBIDDEN],
  ["not_found", NOT_FOUND],
  // Unknown or non-direct profiles are indistinguishable from absent resources.
  ["hermes_profile_not_configured", NOT_FOUND],
  ["hermes_direct_conversations_disabled", NOT_FOUND],

  ["validation_failed", VALIDATION],
  ["hermes_conversation_query_invalid", VALIDATION],
  ["hermes_conversation_request_invalid", VALIDATION],
  ["hermes_message_query_invalid", VALIDATION],
  ["hermes_selection_request_invalid", VALIDATION],
  ["hermes_voice_disabled", VALIDATION],
  ["hermes_images_disabled", VALIDATION],
  ["invalid_cursor", INVALID_CURSOR],
  ["hermes_cursor_invalid", INVALID_CURSOR],

  ["idempotency_key_required", { status: 400, code: "idempotency_key_required" }],
  ["idempotency_key_reused", { status: 409, code: "idempotency_key_reused" }],
  ["version_conflict", { status: 409, code: "version_conflict" }],
  ["hermes_active_conversation_selected", CONFLICT],
  ["hermes_conflict", CONFLICT],
  ["hermes_attachment_unavailable", CONFLICT],
  ["payload_too_large", { status: 413, code: "payload_too_large" }],
  ["event_cursor_expired", { status: 410, code: "event_cursor_expired" }],
  ["too_many_requests", { status: 429, code: "too_many_requests" }],

  ["hermes_not_found", BAD_GATEWAY],
  ["hermes_unauthorized", BAD_GATEWAY],
  ["hermes_response_invalid", BAD_GATEWAY],
  ["hermes_page_limit_exceeded", BAD_GATEWAY],
  ["hermes_upstream_unavailable", UNAVAILABLE],
  ["hermes_request_timeout", UNAVAILABLE],
  ["hermes_conversation_unavailable", UNAVAILABLE],
  ["hermes_conversation_update_failed", UNAVAILABLE],
  ["hermes_selection_update_failed", UNAVAILABLE],
  ["hermes_message_unavailable", UNAVAILABLE],
  ["hermes_upload_unavailable", UNAVAILABLE],
  ["hermes_event_stream_unavailable", UNAVAILABLE],
  ["hermes_delegations_unavailable", UNAVAILABLE],

  ["hermes_clock_invalid", INTERNAL],
  ["hermes_upload_storage_failed", INTERNAL],
]);

const TEXT: Readonly<Partial<Record<ApiProblemCode, Readonly<{ title: string; detail: string }>>>> = {
  validation_failed: { title: "Validation failed", detail: "The request is invalid." },
  invalid_cursor: { title: "Invalid cursor", detail: "The supplied cursor is not valid for this resource." },
  forbidden: { title: "Forbidden", detail: "The authenticated connector principal is not allowed." },
  not_found: { title: "Not found", detail: "The requested item is not available." },
  idempotency_key_required: { title: "Idempotency key required", detail: "The request requires one Idempotency-Key header." },
  idempotency_key_reused: { title: "Idempotency key reused", detail: "The idempotency key was already used for a different request." },
  version_conflict: { title: "Version conflict", detail: "The item changed since the supplied version." },
  conflict: { title: "Conflict", detail: "The request conflicts with the current state." },
  payload_too_large: { title: "Payload too large", detail: "The request body exceeds the allowed size." },
  event_cursor_expired: { title: "Event cursor expired", detail: "The event cursor is outside retention. Reload history and reconnect." },
  too_many_requests: { title: "Too many requests", detail: "Too many concurrent requests. Try again later." },
  dependency_unavailable: { title: "Dependency unavailable", detail: "The agent service is temporarily unavailable." },
  internal_error: { title: "Internal server error", detail: "The connector could not complete the request." },
};

const typedCode = (error: unknown): string | undefined =>
  error instanceof HermesRouteError || error instanceof HermesConversationError || error instanceof HermesMessageError ||
  error instanceof HermesUploadError || error instanceof HermesEventStreamError
    ? error.code
    : undefined;

/** Fastify client errors (wrong media type, malformed framing) carry no content we need: report them as invalid requests. */
const isFastifyClientError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("FST_") &&
  "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 &&
  error.code !== "FST_ERR_CTP_BODY_TOO_LARGE";

export const hermesProblem = (error: unknown, requestId: string, instance: string): ApiProblem => {
  const code = typedCode(error);
  const mapped = code === undefined ? (isFastifyClientError(error) ? VALIDATION : undefined) : HERMES_PROBLEMS.get(code) ?? INTERNAL;
  if (mapped === undefined) return toConnectorProblem(error, requestId, instance);
  const text = TEXT[mapped.code] ?? TEXT.internal_error!;
  return {
    type: `https://pih.example/problems/${mapped.code.replaceAll("_", "-")}`,
    title: text.title,
    status: mapped.status,
    detail: text.detail,
    instance,
    code: mapped.code,
    requestId,
  };
};

export const sendHermesProblem = (reply: FastifyReply, problem: ApiProblem): void => {
  void reply
    .status(problem.status)
    .header("x-request-id", problem.requestId)
    .type("application/problem+json")
    .send(problem);
};

/** Installs the Hermes mapping inside the Hermes plugin's encapsulation context only. */
export const installHermesProblemHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error, request, reply) => {
    const problem = hermesProblem(error, request.id, request.routeOptions.url ?? "/unmatched");
    if (problem.status >= 500) request.log.error({ code: problem.code, requestId: request.id }, "Hermes request failed");
    sendHermesProblem(reply, problem);
  });
};
