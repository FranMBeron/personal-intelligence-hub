import {
  CalendarAgendaQuerySchema,
  CalendarAgendaSchema,
  CalendarAuthorizationStartSchema,
  CalendarChangeProposalSchema,
  CalendarEventDetailSchema,
  CalendarEventListSchema,
  CalendarEventsQuerySchema,
  CalendarOAuthCallbackBodySchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  ConfirmCalendarChangeProposalBodySchema,
  CreateCalendarChangeProposalBodySchema,
  OpaqueNonEmptyStringSchema,
  RejectCalendarChangeProposalBodySchema,
  UpdateCalendarSelectionBodySchema,
  type ConnectorScope,
  type ConnectorServiceId,
  type DelegatedPrincipal,
} from "@personal-intelligence-hub/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireScope, requireService } from "../../foundation/auth.js";
import type { CalendarModuleDependencies } from "../calendar-module.js";
import { toSourceStatus } from "../application/source-status.js";
import { installCalendarProblemHandler } from "./calendar-problems.js";

export type CalendarRoutesOptions = Readonly<{ dependencies: CalendarModuleDependencies }>;

const READERS: readonly ConnectorServiceId[] = ["pih-web", "hermes-central"];
const HUMANS: readonly ConnectorServiceId[] = ["pih-web"];
/** Fastify's router already refuses parameters over 100 characters; this repeats the bound locally. */
const MAX_PATH_REF_LENGTH = 100;

const fail = (code: string): never => { throw new Error(code); };
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail("calendar_query_invalid");
};
const PathRefSchema = OpaqueNonEmptyStringSchema.max(MAX_PATH_REF_LENGTH);
const ProposalParamsSchema = z.object({ id: PathRefSchema }).strict();
const EventParamsSchema = z.object({ eventRef: PathRefSchema }).strict();
const IdempotencyKeySchema = z.string().min(1).max(128);

/**
 * Authorizes from the verified principal only: the scope must be present and the service must be
 * allowed for this route. Configure and confirm routes additionally require a human actor.
 */
const authorize = (
  request: FastifyRequest, scope: ConnectorScope, services: readonly ConnectorServiceId[],
): DelegatedPrincipal => {
  const principal = requireScope(request, scope);
  requireService(request, services);
  if (services === HUMANS && principal.actorType !== "human") fail("forbidden");
  return principal;
};
const read = (request: FastifyRequest) => authorize(request, "calendar:read", READERS);
const propose = (request: FastifyRequest) => authorize(request, "calendar:propose", READERS);
const configure = (request: FastifyRequest) => authorize(request, "calendar:configure", HUMANS);
const confirm = (request: FastifyRequest) => authorize(request, "calendar:confirm", HUMANS);

const noQuery = (request: FastifyRequest): void => {
  if (Object.keys(request.query as object).length > 0) fail("calendar_query_invalid");
};
const noBody = (request: FastifyRequest): void => {
  if (request.body !== undefined) fail("calendar_query_invalid");
};
const query = <T>(request: FastifyRequest, schema: z.ZodType<T>): T => parse(schema, { ...(request.query as object) });
/** Exactly one raw Idempotency-Key header; Node folds repeated headers, so count raw entries. */
const idempotencyKey = (request: FastifyRequest): string => {
  const raw = request.raw.rawHeaders.filter((_value, index, all) => index % 2 === 0 && all[index]!.toLowerCase() === "idempotency-key");
  if (raw.length === 0) return fail("idempotency_key_required");
  if (raw.length !== 1) return fail("calendar_query_invalid");
  return parse(IdempotencyKeySchema, request.headers["idempotency-key"]);
};

/**
 * Thin authenticated handlers: authorize, parse the contract input, call exactly one application
 * service, and parse its contract output before serializing. No SQL, crypto or provider I/O here.
 */
export const calendarRoutes: FastifyPluginAsync<CalendarRoutesOptions> = async (app, { dependencies }) => {
  const { oauth, selection, agenda, events, changes } = dependencies;
  installCalendarProblemHandler(app);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/v1/calendar/status", async (request) => {
    const principal = read(request);
    noQuery(request);
    return CalendarSourceStatusSchema.parse(await oauth.status(principal));
  });

  app.post("/v1/calendar/oauth/authorizations", async (request) => {
    const principal = configure(request);
    noQuery(request);
    noBody(request);
    return CalendarAuthorizationStartSchema.parse(await oauth.start(principal));
  });

  app.post("/v1/calendar/oauth/callback", async (request) => {
    const principal = configure(request);
    noQuery(request);
    const body = parse(CalendarOAuthCallbackBodySchema, request.body);
    return CalendarSourceStatusSchema.parse(await oauth.callback(principal, body));
  });

  app.post("/v1/calendar/bootstrap", async (request) => {
    const principal = configure(request);
    noQuery(request);
    noBody(request);
    return CalendarSourceStatusSchema.parse(await oauth.bootstrap(principal));
  });

  app.delete("/v1/calendar/connection", async (request) => {
    const principal = configure(request);
    noQuery(request);
    noBody(request);
    return toSourceStatus(CalendarSourceStatusSchema.parse(await oauth.disconnect(principal)));
  });

  app.get("/v1/calendar/calendars", async (request) => {
    const principal = configure(request);
    noQuery(request);
    return CalendarSelectionSchema.parse(await selection.discover(principal));
  });

  app.get("/v1/calendar/selection", async (request) => {
    const principal = configure(request);
    noQuery(request);
    return CalendarSelectionSchema.parse(await selection.get(principal));
  });

  app.put("/v1/calendar/selection", async (request) => {
    const principal = configure(request);
    noQuery(request);
    const body = parse(UpdateCalendarSelectionBodySchema, request.body);
    return CalendarSelectionSchema.parse(await selection.update(principal, body));
  });

  app.get("/v1/calendar/agenda", async (request) => {
    const principal = read(request);
    const window = query(request, CalendarAgendaQuerySchema);
    return CalendarAgendaSchema.parse(await agenda.read(principal, window));
  });

  app.get("/v1/calendar/events", async (request) => {
    const principal = read(request);
    const { cursor, ...window } = query(request, CalendarEventsQuerySchema);
    return CalendarEventListSchema.parse(await events.list(principal, cursor === undefined ? window : { ...window, cursor }));
  });

  app.get("/v1/calendar/events/:eventRef", async (request) => {
    const principal = read(request);
    noQuery(request);
    const { eventRef } = parse(EventParamsSchema, { ...(request.params as object) });
    return CalendarEventDetailSchema.parse(await events.get(principal, eventRef));
  });

  app.post("/v1/calendar/change-proposals", async (request) => {
    const principal = propose(request);
    noQuery(request);
    const key = idempotencyKey(request);
    const body = parse(CreateCalendarChangeProposalBodySchema, request.body);
    return CalendarChangeProposalSchema.parse(await changes.create(principal, key, body));
  });

  app.get("/v1/calendar/change-proposals/:id", async (request) => {
    const principal = read(request);
    noQuery(request);
    const { id } = parse(ProposalParamsSchema, { ...(request.params as object) });
    return CalendarChangeProposalSchema.parse(await changes.get(principal, id));
  });

  app.post("/v1/calendar/change-proposals/:id/confirmation", async (request) => {
    const principal = confirm(request);
    noQuery(request);
    const { id } = parse(ProposalParamsSchema, { ...(request.params as object) });
    const body = parse(ConfirmCalendarChangeProposalBodySchema, request.body);
    return CalendarChangeProposalSchema.parse(await changes.confirm(principal, id, body));
  });

  app.post("/v1/calendar/change-proposals/:id/rejection", async (request) => {
    const principal = confirm(request);
    noQuery(request);
    const { id } = parse(ProposalParamsSchema, { ...(request.params as object) });
    const body = parse(RejectCalendarChangeProposalBodySchema, request.body);
    return CalendarChangeProposalSchema.parse(await changes.reject(principal, id, body));
  });

  // Explicit human retry of a proposal left executing after an ambiguous provider outcome.
  app.post("/v1/calendar/change-proposals/:id/reconciliation", async (request) => {
    const principal = confirm(request);
    noQuery(request);
    noBody(request);
    const { id } = parse(ProposalParamsSchema, { ...(request.params as object) });
    return CalendarChangeProposalSchema.parse(await changes.reconcileExecuting(principal, id));
  });
};
