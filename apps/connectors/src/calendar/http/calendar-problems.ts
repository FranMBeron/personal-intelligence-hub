import type { ApiProblem, ApiProblemCode } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";

import { toConnectorProblem } from "../../foundation/problems.js";

type Mapped = Readonly<{ status: number; code: ApiProblemCode }>;

const VALIDATION: Mapped = { status: 400, code: "validation_failed" };
const FORBIDDEN: Mapped = { status: 403, code: "forbidden" };
const NOT_FOUND: Mapped = { status: 404, code: "not_found" };
const CONFLICT: Mapped = { status: 409, code: "conflict" };
const VERSION_CONFLICT: Mapped = { status: 409, code: "version_conflict" };
const UNAVAILABLE: Mapped = { status: 503, code: "dependency_unavailable" };
const BAD_GATEWAY: Mapped = { status: 502, code: "dependency_unavailable" };
const INTERNAL: Mapped = { status: 500, code: "internal_error" };

/**
 * Closed mapping from Calendar service codes to public problems. Service codes never reach the
 * caller: only the contract problem code, its fixed text, and the status do. Anything not listed
 * here (including every provider and crypto code) is an internal error.
 */
const CALENDAR_PROBLEMS: ReadonlyMap<string, Mapped> = new Map<string, Mapped>([
  ["forbidden", FORBIDDEN],
  ["update_not_permitted", FORBIDDEN],
  ["cancel_not_permitted", FORBIDDEN],
  ["invitation_response_not_permitted", FORBIDDEN],
  ["calendar_not_writable", FORBIDDEN],
  ["calendar_write_not_permitted", FORBIDDEN],
  ["calendar_provider_permission_denied", FORBIDDEN],

  ["calendar_result_too_large", { status: 413, code: "payload_too_large" }],
  ["calendar_cursor_expired", { status: 410, code: "cursor_expired" }],
  // Retention erased the proposal content: the item is gone, not merely absent.
  ["proposal_content_purged", { status: 410, code: "not_found" }],
  ["idempotency_conflict", { status: 409, code: "idempotency_key_reused" }],
  ["idempotency_key_required", { status: 400, code: "idempotency_key_required" }],

  ["idempotency_key_invalid", VALIDATION],
  ["calendar_query_invalid", VALIDATION],
  ["calendar_range_too_large", VALIDATION],
  ["calendar_proposal_invalid", VALIDATION],
  ["calendar_selection_invalid", VALIDATION],
  ["calendar_selection_primary_required", VALIDATION],
  ["calendar_write_requires_read_selection", VALIDATION],
  ["calendar_recurrence_scope_invalid", VALIDATION],
  ["calendar_oauth_state_invalid", VALIDATION],
  ["calendar_oauth_required_scope_missing", VALIDATION],

  ["calendar_event_not_found", NOT_FOUND],
  ["calendar_proposal_not_found", NOT_FOUND],
  ["calendar_not_found", NOT_FOUND],

  ["calendar_proposal_version_conflict", VERSION_CONFLICT],
  ["calendar_selection_version_conflict", VERSION_CONFLICT],
  ["calendar_proposal_not_pending", CONFLICT],
  ["calendar_connection_changed", CONFLICT],
  ["calendar_provider_conflict", CONFLICT],
  ["calendar_not_configured", CONFLICT],
  ["calendar_reauthorization_required", CONFLICT],
  ["calendar_primary_unavailable", CONFLICT],
  ["calendar_oauth_refresh_token_missing", CONFLICT],
  // A confirmed change is still running: disconnecting or reconnecting would discard its record.
  ["calendar_proposal_executing", CONFLICT],
  // Storage compare-and-set losers: a concurrent request or deselection changed the proposal or
  // its event reference between the service read and the write.
  ["calendar_proposal_transition_conflict", CONFLICT],
  ["calendar_proposal_detached", CONFLICT],
  ["calendar_event_reference_not_found", CONFLICT],

  ["calendar_provider_temporarily_unavailable", UNAVAILABLE],
  ["calendar_access_token_invalidated", UNAVAILABLE],
  ["calendar_primary_bootstrap_failed", UNAVAILABLE],
  ["calendar_selection_update_failed", UNAVAILABLE],
  ["calendar_provider_request_failed", BAD_GATEWAY],
  ["calendar_provider_response_invalid", BAD_GATEWAY],
  ["calendar_oauth_exchange_failed", BAD_GATEWAY],

  ["calendar_credentials_unavailable", INTERNAL],
  ["calendar_disconnect_failed", INTERNAL],
]);

const TEXT: Readonly<Partial<Record<ApiProblemCode, Readonly<{ title: string; detail: string }>>>> = {
  validation_failed: { title: "Validation failed", detail: "The request is invalid." },
  forbidden: { title: "Forbidden", detail: "The authenticated connector principal is not allowed." },
  not_found: { title: "Not found", detail: "The requested Calendar item is not available." },
  payload_too_large: { title: "Result too large", detail: "The requested Calendar window is too large." },
  cursor_expired: { title: "Cursor expired", detail: "The requested page is no longer available." },
  idempotency_key_required: { title: "Idempotency key required", detail: "The request requires an Idempotency-Key header." },
  idempotency_key_reused: { title: "Idempotency key reused", detail: "The idempotency key was already used for a different request." },
  version_conflict: { title: "Version conflict", detail: "The item changed since the supplied version." },
  conflict: { title: "Conflict", detail: "The request conflicts with the current Calendar state." },
  dependency_unavailable: { title: "Dependency unavailable", detail: "The Calendar provider is temporarily unavailable." },
  internal_error: { title: "Internal server error", detail: "The connector could not complete the request." },
};

/** Only plain Errors raised by Calendar services are mapped; subclasses and framework errors are not. */
const mappedCalendarError = (error: unknown): Mapped | undefined =>
  error instanceof Error && Object.getPrototypeOf(error) === Error.prototype ? CALENDAR_PROBLEMS.get(error.message) : undefined;

export const calendarProblem = (error: unknown, requestId: string, instance: string): ApiProblem => {
  const mapped = mappedCalendarError(error);
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

/**
 * Installs the Calendar problem handler inside the Calendar plugin's encapsulation context. It
 * extends the foundation mapping (which it delegates to for everything it does not own) without
 * changing the foundation handler that other modules use.
 */
export const installCalendarProblemHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    const problem = calendarProblem(error, requestId, request.routeOptions.url ?? "/unmatched");
    if (problem.status >= 500) {
      request.log.error({ code: problem.code, requestId }, "Calendar request failed");
    }
    void reply
      .status(problem.status)
      .header("x-request-id", requestId)
      .type("application/problem+json")
      .send(problem);
  });
};
