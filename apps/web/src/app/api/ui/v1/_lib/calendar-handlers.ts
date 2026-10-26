import "server-only";

import {
  CalendarAgendaQuerySchema,
  CalendarAgendaSchema,
  CalendarAuthorizationStartSchema,
  CalendarChangeProposalSchema,
  CalendarEventDetailSchema,
  CalendarEventListSchema,
  CalendarEventsQuerySchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  ConfirmCalendarChangeProposalBodySchema,
  CreateCalendarChangeProposalBodySchema,
  IdempotencyKeySchema,
  RejectCalendarChangeProposalBodySchema,
  SourceStatusSchema,
  UpdateCalendarSelectionBodySchema,
} from "@personal-intelligence-hub/contracts";
import { ZodError } from "zod";

import type { RequestContext } from "../../../../../server/context";
import type { CalendarGateway } from "../../../../../server/ports/calendar-gateway";
import {
  failureResponse,
  jsonResponse,
  parseJsonBody,
  parseResourceId,
  parseStrictQuery,
  problem,
  problemResponse,
  requireContext,
  requireEmptyQuery,
  requireGateway,
  requireSameOrigin,
  type ContextualRouteHandler,
  type RequestPolicy,
  type RouteHandler,
} from "./request-guards";

/** Upper bound for one agenda/events window; protects the provider from unbounded reads. */
export const MAX_CALENDAR_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_PATHS: ReadonlySet<string> = new Set(["/o/oauth2/v2/auth"]);
const MAX_OAUTH_PARAMETER_LENGTH = 4096;
const OAUTH_PARAMETER_PATTERN = /^[\x21-\x7e]+$/u;

export const CALENDAR_CALLBACK_DESTINATIONS = Object.freeze({
  connected: "/system?calendar=connected",
  attention: "/system?calendar=attention",
});

type Authenticated = { ok: true; context: RequestContext } | { ok: false; response: Response };

/** Verified identity plus an explicit human principal; anything else fails closed. */
const requireHuman = async (request: Request, policy: RequestPolicy): Promise<Authenticated> => {
  const authenticated = await requireContext(request, policy);
  if (!authenticated.ok) return authenticated;
  if (authenticated.context.principal?.actorType === "human") return authenticated;
  return {
    ok: false,
    response: problemResponse(problem(
      request, authenticated.context, 401, "authentication_required", "Authentication required",
      "A verified human identity is required for Calendar operations.",
    )),
  };
};

const calendarGateway = (
  request: Request,
  context: RequestContext,
  gateway: CalendarGateway | null,
): CalendarGateway | Response => requireGateway(request, context, gateway, "Calendar", { notConfiguredStatus: 501 });

type Operation = (gateway: CalendarGateway, context: RequestContext) => Promise<Response>;

/**
 * Shared skeleton: identity first, then Origin for mutations, then the
 * operation (which validates input before touching the gateway).
 */
const run = async (
  request: Request,
  policy: RequestPolicy,
  gateway: CalendarGateway | null,
  options: Readonly<{ mutation: boolean; emptyQuery: boolean }>,
  operation: Operation,
): Promise<Response> => {
  const authenticated = await requireHuman(request, policy);
  if (!authenticated.ok) return authenticated.response;
  const { context } = authenticated;
  if (options.mutation) {
    const originFailure = requireSameOrigin(request, context, policy);
    if (originFailure !== null) return originFailure;
  }
  if (options.emptyQuery) {
    const queryFailure = requireEmptyQuery(request, context);
    if (queryFailure !== null) return queryFailure;
  }
  try {
    const available = calendarGateway(request, context, gateway);
    if (available instanceof Response) return available;
    return await operation(available, context);
  } catch (error) {
    return failureResponse(request, context, error);
  }
};

const READ = { mutation: false, emptyQuery: true } as const;
const WRITE = { mutation: true, emptyQuery: true } as const;

const boundedWindow = <T extends { from: string; to: string }>(query: T): T => {
  if (Date.parse(query.to) - Date.parse(query.from) > MAX_CALENDAR_WINDOW_MS) {
    throw new ZodError([{ code: "custom", path: ["to"], message: "The requested window is too large." }]);
  }
  return query;
};

const isApprovedAuthorizationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.origin === GOOGLE_AUTHORIZATION_ORIGIN &&
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      GOOGLE_AUTHORIZATION_PATHS.has(url.pathname);
  } catch {
    return false;
  }
};

export const createCalendarStatusHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, READ, async (available, context) =>
    jsonResponse(CalendarSourceStatusSchema.parse(await available.status(context, request.signal)), context.requestId));

export const createCalendarCalendarsHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, READ, async (available, context) =>
    jsonResponse(CalendarSelectionSchema.parse(await available.calendars(context, request.signal)), context.requestId));

export const createCalendarSelectionHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, READ, async (available, context) =>
    jsonResponse(CalendarSelectionSchema.parse(await available.selection(context, request.signal)), context.requestId));

export const createUpdateCalendarSelectionHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, WRITE, async (available, context) => {
    const body = await parseJsonBody(request, UpdateCalendarSelectionBodySchema);
    return jsonResponse(
      CalendarSelectionSchema.parse(await available.updateSelection(context, body, request.signal)),
      context.requestId,
    );
  });

export const createCalendarAgendaHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, { mutation: false, emptyQuery: false }, async (available, context) => {
    const query = boundedWindow(parseStrictQuery(request, CalendarAgendaQuerySchema));
    return jsonResponse(CalendarAgendaSchema.parse(await available.agenda(context, query, request.signal)), context.requestId);
  });

export const createCalendarEventsHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, { mutation: false, emptyQuery: false }, async (available, context) => {
    const query = boundedWindow(parseStrictQuery(request, CalendarEventsQuerySchema));
    return jsonResponse(CalendarEventListSchema.parse(await available.events(context, query, request.signal)), context.requestId);
  });

export const createCalendarEventHandler = (
  gateway: CalendarGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"eventRef"> =>
  (request, routeContext) => run(request, policy, gateway, READ, async (available, context) => {
    const eventRef = parseResourceId((await routeContext.params).eventRef);
    return jsonResponse(CalendarEventDetailSchema.parse(await available.event(context, eventRef, request.signal)), context.requestId);
  });

export const createCalendarStartAuthorizationHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, WRITE, async (available, context) => {
    const start = CalendarAuthorizationStartSchema.safeParse(await available.startAuthorization(context, request.signal));
    if (!start.success || !isApprovedAuthorizationUrl(start.data.authorizationUrl)) {
      return problemResponse(problem(
        request, context, 502, "dependency_unavailable", "Calendar authorization unavailable",
        "Calendar authorization could not be started safely.",
      ));
    }
    return jsonResponse(start.data, context.requestId);
  });

export const createCalendarBootstrapHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, WRITE, async (available, context) =>
    jsonResponse(CalendarSourceStatusSchema.parse(await available.bootstrap(context, request.signal)), context.requestId));

export const createCalendarDisconnectHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, WRITE, async (available, context) =>
    jsonResponse(SourceStatusSchema.parse(await available.disconnect(context, request.signal)), context.requestId));

export const createCalendarProposeHandler = (gateway: CalendarGateway | null, policy: RequestPolicy): RouteHandler =>
  (request) => run(request, policy, gateway, WRITE, async (available, context) => {
    const idempotency = IdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!idempotency.success) {
      return problemResponse(problem(
        request, context, 400, "idempotency_key_required", "Valid idempotency key required",
        "Idempotency-Key must contain 8 to 255 visible ASCII characters.",
      ));
    }
    const body = await parseJsonBody(request, CreateCalendarChangeProposalBodySchema);
    return jsonResponse(
      CalendarChangeProposalSchema.parse(await available.propose(context, idempotency.data, body, request.signal)),
      context.requestId,
      201,
    );
  });

export const createCalendarProposalHandler = (
  gateway: CalendarGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"proposalId"> =>
  (request, routeContext) => run(request, policy, gateway, READ, async (available, context) => {
    const proposalId = parseResourceId((await routeContext.params).proposalId);
    return jsonResponse(CalendarChangeProposalSchema.parse(await available.proposal(context, proposalId, request.signal)), context.requestId);
  });

export const createCalendarConfirmationHandler = (
  gateway: CalendarGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"proposalId"> =>
  (request, routeContext) => run(request, policy, gateway, WRITE, async (available, context) => {
    const proposalId = parseResourceId((await routeContext.params).proposalId);
    const body = await parseJsonBody(request, ConfirmCalendarChangeProposalBodySchema);
    return jsonResponse(
      CalendarChangeProposalSchema.parse(await available.confirm(context, proposalId, body, request.signal)),
      context.requestId,
    );
  });

export const createCalendarRejectionHandler = (
  gateway: CalendarGateway | null,
  policy: RequestPolicy,
): ContextualRouteHandler<"proposalId"> =>
  (request, routeContext) => run(request, policy, gateway, WRITE, async (available, context) => {
    const proposalId = parseResourceId((await routeContext.params).proposalId);
    const body = await parseJsonBody(request, RejectCalendarChangeProposalBodySchema);
    return jsonResponse(
      CalendarChangeProposalSchema.parse(await available.reject(context, proposalId, body, request.signal)),
      context.requestId,
    );
  });

const callbackRedirect = (destination: keyof typeof CALENDAR_CALLBACK_DESTINATIONS): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: CALENDAR_CALLBACK_DESTINATIONS[destination],
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

const singleOAuthParameter = (parameters: URLSearchParams, name: string): string | null => {
  const values = parameters.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0]!;
  return value.length <= MAX_OAUTH_PARAMETER_LENGTH && OAUTH_PARAMETER_PATTERN.test(value) ? value : null;
};

/**
 * Browser-facing OAuth redirect target. It is a GET and therefore exempt from
 * the mutation Origin guard: connectors validates the one-use, actor-bound
 * `state` (and the PKCE verifier) before any code exchange. The BFF only
 * forwards `code` and `state` for the verified human and always redirects to
 * one of two fixed same-origin paths, regardless of any other parameter.
 */
export const createCalendarOAuthCallbackHandler = (
  gateway: CalendarGateway | null,
  policy: RequestPolicy,
): RouteHandler =>
  async (request) => {
    const parameters = new URL(request.url).searchParams;
    if (parameters.has("error")) return callbackRedirect("attention");
    const code = singleOAuthParameter(parameters, "code");
    const state = singleOAuthParameter(parameters, "state");
    if (code === null || state === null || gateway === null) return callbackRedirect("attention");
    const authenticated = await requireHuman(request, policy);
    if (!authenticated.ok) return callbackRedirect("attention");
    try {
      const status = CalendarSourceStatusSchema.parse(
        await gateway.completeAuthorization(authenticated.context, { code, state }, request.signal),
      );
      return callbackRedirect(status.state === "available" ? "connected" : "attention");
    } catch {
      return callbackRedirect("attention");
    }
  };
