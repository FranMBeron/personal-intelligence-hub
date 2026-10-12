import "server-only";

import type {
  CalendarAgenda,
  CalendarAgendaQuery,
  CalendarAuthorizationStart,
  CalendarChangeProposal,
  CalendarEventDetail,
  CalendarEventList,
  CalendarEventsQuery,
  CalendarOAuthCallbackBody,
  CalendarSelection,
  CalendarSourceStatus,
  ConfirmCalendarChangeProposalBody,
  CreateCalendarChangeProposalBody,
  SourceStatus,
  UpdateCalendarSelectionBody,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export interface CalendarGateway {
  status(context: RequestContext, signal?: AbortSignal): Promise<CalendarSourceStatus>;
  startAuthorization(context: RequestContext, signal?: AbortSignal): Promise<CalendarAuthorizationStart>;
  completeAuthorization(context: RequestContext, body: CalendarOAuthCallbackBody, signal?: AbortSignal): Promise<CalendarSourceStatus>;
  bootstrap(context: RequestContext, signal?: AbortSignal): Promise<CalendarSourceStatus>;
  disconnect(context: RequestContext, signal?: AbortSignal): Promise<SourceStatus>;
  calendars(context: RequestContext, signal?: AbortSignal): Promise<CalendarSelection>;
  selection(context: RequestContext, signal?: AbortSignal): Promise<CalendarSelection>;
  updateSelection(context: RequestContext, body: UpdateCalendarSelectionBody, signal?: AbortSignal): Promise<CalendarSelection>;
  agenda(context: RequestContext, query: CalendarAgendaQuery, signal?: AbortSignal): Promise<CalendarAgenda>;
  events(context: RequestContext, query: CalendarEventsQuery, signal?: AbortSignal): Promise<CalendarEventList>;
  event(context: RequestContext, eventRef: string, signal?: AbortSignal): Promise<CalendarEventDetail>;
  propose(context: RequestContext, body: CreateCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal>;
  proposal(context: RequestContext, id: string, signal?: AbortSignal): Promise<CalendarChangeProposal>;
  confirm(context: RequestContext, id: string, body: ConfirmCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal>;
  reject(context: RequestContext, id: string, body: ConfirmCalendarChangeProposalBody, signal?: AbortSignal): Promise<CalendarChangeProposal>;
}
