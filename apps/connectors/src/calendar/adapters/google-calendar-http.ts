import { z } from "zod";

import type {
  GoogleCalendarPort,
  GoogleCalendarRecord,
  GoogleCreateEventRequest,
  GoogleDeleteEventRequest,
  GoogleEventPage,
  GoogleEventRecord,
  GoogleInvitationResponseRequest,
  GoogleListEventsRequest,
  GoogleUpdateEventRequest,
} from "../ports/google-calendar.js";

const API_BASE = "https://www.googleapis.com/calendar/v3/";
const MAX_PAGES = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SafePathIdSchema = z.string().min(1).max(1024).refine((value) =>
  !/^https?:\/\//iu.test(value) && !/[?#\u0000-\u001f]/u.test(value) &&
  !value.split(/[\\/]/u).some((segment) => segment === "." || segment === ".."),
);
const CalendarIdSchema = SafePathIdSchema;
const EventIdSchema = SafePathIdSchema;
const SendUpdatesSchema = z.enum(["all", "externalOnly", "none"]);
const CalendarItemSchema = z.object({
  id: z.string().min(1).max(1024),
  summary: z.string().max(2000).nullable().optional(),
  summaryOverride: z.string().max(2000).nullable().optional(),
  primary: z.boolean().optional(),
  accessRole: z.enum(["freeBusyReader", "reader", "writer", "owner"]),
  timeZone: z.string().max(200).optional(),
}).passthrough();
const EventTimeSchema = z.object({
  date: z.string().min(1).max(64).optional(),
  dateTime: z.string().min(1).max(64).optional(),
  timeZone: z.string().min(1).max(200).optional(),
}).passthrough().refine((value) => value.date !== undefined || value.dateTime !== undefined);
const EventSchema = z.object({
  id: z.string().min(1).max(1024),
  etag: z.string().min(1).max(1024),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  summary: z.string().max(2000).optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2000).optional(),
  start: EventTimeSchema,
  end: EventTimeSchema,
  organizer: z.object({ self: z.boolean().optional() }).passthrough().optional(),
  attendees: z.array(z.object({
    email: z.string().email().max(320).optional(),
    displayName: z.string().max(500).optional(),
    responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
  }).passthrough()).max(500).optional(),
  recurringEventId: z.string().min(1).optional(),
  originalStartTime: EventTimeSchema.optional(),
  updated: z.string().datetime({ offset: true }),
}).passthrough();
const EventPageSchema = z.object({
  items: z.array(EventSchema).max(250),
  nextPageToken: z.string().min(1).max(2048).optional(),
}).passthrough();
const WritableEventTimeSchema = z.object({
  date: z.string().min(1).max(64).optional(),
  dateTime: z.string().min(1).max(64).optional(),
  timeZone: z.string().min(1).max(200).optional(),
}).strict().refine((value) => value.date !== undefined || value.dateTime !== undefined);
const InvitationResponseSchema = z.enum(["accepted", "declined", "tentative", "removed"]);
const WritableEventSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  description: z.string().max(20_000).optional(),
  location: z.string().max(2000).optional(),
  start: WritableEventTimeSchema,
  end: WritableEventTimeSchema,
  attendees: z.array(z.object({ email: z.string().email().max(320) }).strict()).max(100).optional(),
}).strict();

type Options = Readonly<{ fetch?: typeof fetch; timeoutMs?: number }>;
const fail = (code: string): never => { throw new Error(code); };
const safeErrorCodes = new Set([
  "google_calendar_request_invalid",
  "google_calendar_request_failed",
  "google_calendar_response_invalid",
  "google_calendar_response_too_large",
  "google_calendar_reauthorization_required",
  "google_calendar_permission_denied",
  "google_calendar_not_found",
  "google_calendar_conflict",
  "google_calendar_temporarily_unavailable",
  "google_calendar_timeout",
]);
const isSafeError = (error: unknown): error is Error =>
  error instanceof Error && safeErrorCodes.has(error.message);
const projectTime = (value: z.infer<typeof EventTimeSchema>) => ({
  ...(value.date === undefined ? {} : { date: value.date }),
  ...(value.dateTime === undefined ? {} : { dateTime: value.dateTime }),
  ...(value.timeZone === undefined ? {} : { timeZone: value.timeZone }),
});
const projectEvent = (input: unknown): GoogleEventRecord => {
  const parsed = EventSchema.safeParse(input);
  if (!parsed.success) return fail("google_calendar_response_invalid");
  const event = parsed.data;
  return {
    id: event.id, etag: event.etag, status: event.status,
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.location === undefined ? {} : { location: event.location }),
    start: projectTime(event.start), end: projectTime(event.end),
    ...(event.organizer === undefined ? {} : { organizer: { ...(event.organizer.self === undefined ? {} : { self: event.organizer.self }) } }),
    ...(event.attendees === undefined ? {} : { attendees: event.attendees.map((attendee) => ({
      ...(attendee.email === undefined ? {} : { email: attendee.email }),
      ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName }),
      ...(attendee.responseStatus === undefined ? {} : { responseStatus: attendee.responseStatus }),
    })) }),
    ...(event.recurringEventId === undefined ? {} : { recurringEventId: event.recurringEventId }),
    ...(event.originalStartTime === undefined ? {} : { originalStartTime: projectTime(event.originalStartTime) }),
    updated: event.updated,
  };
};
const pathSegment = (value: string, schema: z.ZodType<string>): string => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail("google_calendar_request_invalid");
  return encodeURIComponent(parsed.data);
};
const validateToken = (token: string): string => {
  if (typeof token !== "string" || token.trim().length === 0 || token.length > 8192) {
    return fail("google_calendar_request_invalid");
  }
  return token;
};

export class GoogleCalendarHttpAdapter implements GoogleCalendarPort {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: Options = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000) {
      fail("google_calendar_timeout_invalid");
    }
  }

  async listCalendars(accessToken: string): Promise<readonly GoogleCalendarRecord[]> {
    const results: GoogleCalendarRecord[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL("users/me/calendarList", API_BASE);
      url.searchParams.set("maxResults", "250");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const payload = await this.#json(accessToken, url, "GET");
      if (payload === null || typeof payload !== "object" || !Array.isArray((payload as { items?: unknown }).items)) {
        return fail("google_calendar_response_invalid");
      }
      const data = payload as { items: unknown[]; nextPageToken?: unknown };
      for (const raw of data.items) {
        const item = CalendarItemSchema.safeParse(raw);
        if (!item.success) return fail("google_calendar_response_invalid");
        results.push({
          id: item.data.id,
          summary: (item.data.summaryOverride ?? item.data.summary ?? "Unnamed calendar").slice(0, 200),
          primary: item.data.primary ?? false,
          accessRole: item.data.accessRole,
          ...(item.data.timeZone === undefined ? {} : { timeZone: item.data.timeZone }),
        });
      }
      if (data.nextPageToken === undefined) return Object.freeze(results);
      if (typeof data.nextPageToken !== "string" || data.nextPageToken.length === 0 || seen.has(data.nextPageToken)) {
        return fail("google_calendar_response_invalid");
      }
      seen.add(data.nextPageToken);
      if (page + 1 === MAX_PAGES) return fail("google_calendar_response_invalid");
      pageToken = data.nextPageToken;
    }
    return fail("google_calendar_response_invalid");
  }

  async listEvents(accessToken: string, request: GoogleListEventsRequest): Promise<GoogleEventPage> {
    const calendarId = pathSegment(request.calendarId, CalendarIdSchema);
    if (!validTimeBound(request.timeMin) || !validTimeBound(request.timeMax) ||
        request.timeZone.length === 0 || request.timeZone.length > 200 ||
        (request.pageToken !== undefined && (request.pageToken.length === 0 || request.pageToken.length > 2048))) {
      return fail("google_calendar_request_invalid");
    }
    const url = new URL(`calendars/${calendarId}/events`, API_BASE);
    url.searchParams.set("timeMin", request.timeMin);
    url.searchParams.set("timeMax", request.timeMax);
    url.searchParams.set("timeZone", request.timeZone);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "250");
    if (request.pageToken !== undefined) url.searchParams.set("pageToken", request.pageToken);
    const parsed = EventPageSchema.safeParse(await this.#json(accessToken, url, "GET"));
    if (!parsed.success) return fail("google_calendar_response_invalid");
    return {
      items: Object.freeze(parsed.data.items.map(projectEvent)),
      ...(parsed.data.nextPageToken === undefined ? {} : { nextPageToken: parsed.data.nextPageToken }),
    };
  }

  async getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEventRecord> {
    const calendar = pathSegment(calendarId, CalendarIdSchema);
    const event = pathSegment(eventId, EventIdSchema);
    return projectEvent(await this.#json(accessToken, new URL(`calendars/${calendar}/events/${event}`, API_BASE), "GET"));
  }

  async createEvent(accessToken: string, request: GoogleCreateEventRequest): Promise<GoogleEventRecord> {
    const calendar = pathSegment(request.calendarId, CalendarIdSchema);
    const eventId = pathSegment(request.providerEventId, EventIdSchema);
    const body = WritableEventSchema.safeParse(request.event);
    const sendUpdates = SendUpdatesSchema.safeParse(request.sendUpdates);
    if (!body.success || !sendUpdates.success) return fail("google_calendar_request_invalid");
    const url = new URL(`calendars/${calendar}/events`, API_BASE);
    url.searchParams.set("sendUpdates", sendUpdates.data);
    return projectEvent(await this.#json(accessToken, url, "POST", { id: eventId, ...body.data }));
  }

  async updateEvent(accessToken: string, request: GoogleUpdateEventRequest): Promise<GoogleEventRecord> {
    const calendar = pathSegment(request.calendarId, CalendarIdSchema);
    const event = pathSegment(request.eventId, EventIdSchema);
    const body = WritableEventSchema.safeParse(request.event);
    const sendUpdates = SendUpdatesSchema.safeParse(request.sendUpdates);
    if (!body.success || !sendUpdates.success || !validEtag(request.expectedEtag)) return fail("google_calendar_request_invalid");
    const url = new URL(`calendars/${calendar}/events/${event}`, API_BASE);
    url.searchParams.set("sendUpdates", sendUpdates.data);
    return projectEvent(await this.#json(accessToken, url, "PATCH", body.data, { "if-match": request.expectedEtag }));
  }

  async deleteEvent(accessToken: string, request: GoogleDeleteEventRequest): Promise<void> {
    const calendar = pathSegment(request.calendarId, CalendarIdSchema);
    const event = pathSegment(request.eventId, EventIdSchema);
    const sendUpdates = SendUpdatesSchema.safeParse(request.sendUpdates);
    if (!sendUpdates.success || !validEtag(request.expectedEtag)) return fail("google_calendar_request_invalid");
    const url = new URL(`calendars/${calendar}/events/${event}`, API_BASE);
    url.searchParams.set("sendUpdates", sendUpdates.data);
    await this.#request(accessToken, url, "DELETE", undefined, { "if-match": request.expectedEtag }, true);
  }

  async respondToInvitation(accessToken: string, request: GoogleInvitationResponseRequest): Promise<GoogleEventRecord | void> {
    const response = InvitationResponseSchema.safeParse(request.response);
    if (!response.success) return fail("google_calendar_request_invalid");
    if (response.data === "removed") {
      await this.deleteEvent(accessToken, {
        calendarId: request.calendarId, eventId: request.eventId,
        expectedEtag: request.expectedEtag, sendUpdates: request.sendUpdates,
      });
      return;
    }
    const calendar = pathSegment(request.calendarId, CalendarIdSchema);
    const event = pathSegment(request.eventId, EventIdSchema);
    const sendUpdates = SendUpdatesSchema.safeParse(request.sendUpdates);
    if (!sendUpdates.success || !validEtag(request.expectedEtag)) return fail("google_calendar_request_invalid");
    const responseStatus = response.data === "tentative" ? "tentative" : response.data;
    const url = new URL(`calendars/${calendar}/events/${event}`, API_BASE);
    url.searchParams.set("sendUpdates", sendUpdates.data);
    return projectEvent(await this.#json(accessToken, url, "PATCH", {
      attendeesOmitted: true,
      attendees: [{ responseStatus }],
    }, { "if-match": request.expectedEtag }));
  }

  async #json(
    token: string, url: URL, method: "GET" | "POST" | "PATCH", body?: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    return this.#execute(token, url, method, body, extraHeaders, async (response) => {
      const text = await readBoundedText(response, MAX_BODY_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return fail("google_calendar_response_invalid");
      }
    });
  }

  async #request(
    accessToken: string,
    url: URL,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
    allowEmpty = false,
  ): Promise<void> {
    await this.#execute(accessToken, url, method, body, extraHeaders, async (response) => {
      if (!allowEmpty && response.body === null) return fail("google_calendar_response_invalid");
      if (allowEmpty && response.body !== null) await response.body.cancel().catch(() => undefined);
    }, allowEmpty);
  }

  async #execute<T>(
    accessToken: string,
    url: URL,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body: unknown,
    extraHeaders: Readonly<Record<string, string>>,
    consume: (response: Response) => Promise<T>,
    allowEmpty = false,
  ): Promise<T> {
    const token = validateToken(accessToken);
    if (url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/")) {
      return fail("google_calendar_request_invalid");
    }
    const controller = new AbortController();
    let responseForCancellation: Response | undefined;
    let rejectTimeout!: (error: Error) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      void responseForCancellation?.body?.cancel().catch(() => undefined);
      rejectTimeout(new Error("google_calendar_timeout"));
    }, this.#timeoutMs);
    const operation = (async (): Promise<T> => {
      const response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: controller.signal,
      });
      responseForCancellation = response;
      if (response.status >= 300 && response.status < 400) return fail("google_calendar_request_failed");
      if (response.status === 401) return fail("google_calendar_reauthorization_required");
      if (response.status === 403) return fail("google_calendar_permission_denied");
      if (response.status === 404) return fail("google_calendar_not_found");
      if (response.status === 410 || response.status === 412) return fail("google_calendar_conflict");
      if (response.status === 429 || response.status >= 500) return fail("google_calendar_temporarily_unavailable");
      if (!response.ok) return fail("google_calendar_request_failed");
      if (allowEmpty && (response.status === 204 || response.headers.get("content-length") === "0")) return await consume(response);
      return await consume(response);
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof Error && error.message === "google_calendar_timeout") return fail("google_calendar_timeout");
      if (isSafeError(error)) throw error;
      if (controller.signal.aborted) return fail("google_calendar_timeout");
      return fail("google_calendar_temporarily_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

const validTimeBound = (value: string): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
const validEtag = (value: string): boolean =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\r\n]/u.test(value);

const readBoundedText = async (response: Response, maxBytes: number): Promise<string> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) return fail("google_calendar_response_too_large");
  if (response.body === null) return fail("google_calendar_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return fail("google_calendar_response_too_large");
      }
      chunks.push(value);
    }
  } catch {
    return fail("google_calendar_response_invalid");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("google_calendar_response_invalid");
  }
};

