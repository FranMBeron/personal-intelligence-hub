import {
  CalendarAuthorizationStartSchema,
  CalendarChangeProposalSchema,
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  SourceStatusSchema,
  type CalendarAuthorizationStart,
  type CalendarChangeProposal,
  type CalendarSelection,
  type CalendarSourceStatus,
  type CreateCalendarChangeProposalBody,
  type SourceStatus,
  type UpdateCalendarSelectionBody,
} from "@personal-intelligence-hub/contracts";

import { bffJson, type Fetcher } from "../../_lib/bff-request";

const base = "/api/ui/v1/calendar";
const proposalPath = (id: string) => `${base}/change-proposals/${encodeURIComponent(id)}`;

/**
 * Browser-side Calendar operations, all through the same-origin BFF. Responses are validated
 * against shared contracts; no provider token, socket path or upstream identifier is ever handled here.
 */
export class CalendarClient {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  status(signal?: AbortSignal): Promise<CalendarSourceStatus> {
    return bffJson(this.fetcher, `${base}/status`, CalendarSourceStatusSchema, { signal });
  }

  startAuthorization(signal?: AbortSignal): Promise<CalendarAuthorizationStart> {
    return bffJson(this.fetcher, `${base}/oauth/authorizations`, CalendarAuthorizationStartSchema, { method: "POST", signal });
  }

  bootstrap(signal?: AbortSignal): Promise<CalendarSourceStatus> {
    return bffJson(this.fetcher, `${base}/bootstrap`, CalendarSourceStatusSchema, { method: "POST", signal });
  }

  disconnect(signal?: AbortSignal): Promise<SourceStatus> {
    return bffJson(this.fetcher, `${base}/connection`, SourceStatusSchema, { method: "DELETE", signal });
  }

  /** Discovery of calendars granted by the provider; it never persists a change. */
  calendars(signal?: AbortSignal): Promise<CalendarSelection> {
    return bffJson(this.fetcher, `${base}/calendars`, CalendarSelectionSchema, { signal });
  }

  selection(signal?: AbortSignal): Promise<CalendarSelection> {
    return bffJson(this.fetcher, `${base}/selection`, CalendarSelectionSchema, { signal });
  }

  updateSelection(body: UpdateCalendarSelectionBody, signal?: AbortSignal): Promise<CalendarSelection> {
    return bffJson(this.fetcher, `${base}/selection`, CalendarSelectionSchema, { method: "PUT", body, signal });
  }

  proposal(id: string, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return bffJson(this.fetcher, proposalPath(id), CalendarChangeProposalSchema, { signal });
  }

  /** Creates a reviewable proposal. The caller keeps `idempotencyKey` for the whole user intent so a retry is not a second proposal. */
  propose(body: CreateCalendarChangeProposalBody, idempotencyKey: string, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return bffJson(this.fetcher, `${base}/change-proposals`, CalendarChangeProposalSchema, {
      method: "POST", body, signal, headers: { "idempotency-key": idempotencyKey },
    });
  }

  confirm(id: string, expectedVersion: number, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return bffJson(this.fetcher, `${proposalPath(id)}/confirmation`, CalendarChangeProposalSchema, { method: "POST", body: { expectedVersion }, signal });
  }

  reject(id: string, expectedVersion: number, signal?: AbortSignal): Promise<CalendarChangeProposal> {
    return bffJson(this.fetcher, `${proposalPath(id)}/rejection`, CalendarChangeProposalSchema, { method: "POST", body: { expectedVersion }, signal });
  }
}

export type CalendarApi = Pick<CalendarClient,
  "status" | "startAuthorization" | "bootstrap" | "disconnect" | "calendars" | "selection" |
  "updateSelection" | "proposal" | "propose" | "confirm" | "reject">;
