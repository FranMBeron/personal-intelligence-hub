import "server-only";

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
  SourceStatusSchema,
  UpdateCalendarSelectionBodySchema,
  type CalendarAgenda,
  type CalendarAgendaQuery,
  type CalendarAuthorizationStart,
  type CalendarChangeProposal,
  type CalendarEventDetail,
  type CalendarEventList,
  type CalendarEventsQuery,
  type CalendarOAuthCallbackBody,
  type CalendarSelection,
  type CalendarSourceStatus,
  type ConfirmCalendarChangeProposalBody,
  type CreateCalendarChangeProposalBody,
  type SourceStatus,
  type UpdateCalendarSelectionBody,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import type { CalendarGateway } from "../ports/calendar-gateway";
import type { ConnectorsHttp } from "./connectors-http";

const queryPath = (path: string, values: Readonly<Record<string, string | undefined>>): string => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, value);
  }
  const query = parameters.toString();
  return query === "" ? path : path + "?" + query;
};

export class HttpCalendarGateway implements CalendarGateway {
  constructor(private readonly http: Pick<ConnectorsHttp, "json">) {}

  status(context: RequestContext, signal?: AbortSignal): Promise<CalendarSourceStatus> {
    return this.http.json(context, { path: "/v1/calendar/status", method: "GET", schema: CalendarSourceStatusSchema, scope: "calendar:read", signal });
  }

  startAuthorization(context: RequestContext, signal?: AbortSignal): Promise<CalendarAuthorizationStart> {
    return this.http.json(context, { path: "/v1/calendar/oauth/authorizations", method: "POST", schema: CalendarAuthorizationStartSchema, scope: "calendar:configure", signal });
  }

  completeAuthorization(context: RequestContext, body: CalendarOAuthCallbackBody, signal?: AbortSignal): Promise<CalendarSourceStatus> {
    return this.http.json(context, { path: "/v1/calendar/oauth/callback", method: "POST", schema: CalendarSourceStatusSchema, body: CalendarOAuthCallbackBodySchema.parse(body), scope: "calendar:configure", signal });
  }

  bootstrap(context: RequestContext, signal?: AbortSignal): Promise<CalendarSourceStatus> {
    return this.http.json(context, { path: "/v1/calendar/bootstrap", method: "POST", schema: CalendarSourceStatusSchema, scope: "calendar:configure", signal });
  }

  disconnect(context: RequestContext, signal?: AbortSignal): Promise<SourceStatus> {
    return this.http.json(context, { path: "/v1/calendar/connection", method: "DELETE", schema: SourceStatusSchema, scope: "calendar:configure", signal });
  }

  calendars(context: RequestContext, signal?: AbortSignal): Promise<CalendarSelection> {
    return this.http.json(context, { path: "/v1/calendar/calendars", method: "GET", schema: CalendarSelectionSchema, scope: "calendar:read", signal });
  }

  selection(context: RequestContext, signal?: AbortSignal): Promise<CalendarSelection> {
    return this.http.json(context, { path: "/v1/calendar/selection", method: "GET", schema: CalendarSelectionSchema, scope: "calendar:read", signal });
  }

  updateSelection(context: RequestContext, body: UpdateCalendarSelectionBody, signal?: AbortSignal): Promise<CalendarSelection> {
    return this.http.json(context, { path: "/v1/calendar/selection", method: "PUT", schema: CalendarSelectionSchema, body: UpdateCalendarSelectionBodySchema.parse(body), scope: "calendar:configure", signal });
  }

  agenda(context: RequestContext, query: CalendarAgendaQuery, signal?: AbortSignal): Promise<CalendarAgenda> {
    const parsed = CalendarAgendaQuerySchema.parse(query);
    return this.http.json(context, { path: queryPath("/v1/calendar/agenda", parsed), method: "GET", schema: CalendarAgendaSchema, scope: "calendar:read", signal });
  }

  events(context: RequestContext, query: CalendarEventsQuery, signal?: AbortSignal): Promise<CalendarEventList> {
    const parsed = CalendarEventsQuerySchema.parse(query);
    return this.http.json(context, { path: queryPath("/v1/calendar/events", parsed), method: "GET", schema: CalendarEventListSchema, scope: "calendar:read", signal });
  }

  event(context: RequestContext, eventRef: string, signal?: AbortSignal): Promise<CalendarEventDetail> {
    return this.http.json(context, { path: "/v1/calendar/events/" + encodeURIComponent(eventRef), method: "GET", schema: CalendarEventDetailSchema, scope: "calendar:read", signal });
  }

  propose(context: RequestContext, body: CreateCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return this.http.json(context, { path: "/v1/calendar/change-proposals", method: "POST", schema: CalendarChangeProposalSchema, body: CreateCalendarChangeProposalBodySchema.parse(body), scope: "calendar:propose", signal });
  }

  proposal(context: RequestContext, id: string, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return this.http.json(context, { path: "/v1/calendar/change-proposals/" + encodeURIComponent(id), method: "GET", schema: CalendarChangeProposalSchema, scope: "calendar:read", signal });
  }

  confirm(context: RequestContext, id: string, body: ConfirmCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return this.http.json(context, { path: "/v1/calendar/change-proposals/" + encodeURIComponent(id) + "/confirmation", method: "POST", schema: CalendarChangeProposalSchema, body: ConfirmCalendarChangeProposalBodySchema.parse(body), scope: "calendar:confirm", signal });
  }

  reject(context: RequestContext, id: string, body: ConfirmCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return this.http.json(context, { path: "/v1/calendar/change-proposals/" + encodeURIComponent(id) + "/rejection", method: "POST", schema: CalendarChangeProposalSchema, body: ConfirmCalendarChangeProposalBodySchema.parse(body), scope: "calendar:confirm", signal });
  }
}
