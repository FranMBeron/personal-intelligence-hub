export type GoogleCalendarRecord = Readonly<{
  id: string;
  summary: string;
  primary: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  timeZone?: string;
}>;

export type GoogleListEventsRequest = Readonly<{
  calendarId: string;
  timeMin: string;
  timeMax: string;
  pageToken?: string;
  timeZone: string;
}>;

export type GoogleEventRecord = Readonly<{
  id: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  end: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  organizer?: Readonly<{ self?: boolean }>;
  attendees?: readonly Readonly<{
    email?: string;
    displayName?: string;
    /** True for the attendee entry that represents the authorized account. */
    self?: boolean;
    responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
  }>[];
  recurringEventId?: string;
  originalStartTime?: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  updated: string;
}>;

export type GoogleEventPage = Readonly<{
  items: readonly GoogleEventRecord[];
  nextPageToken?: string;
}>;

export type GoogleWritableEvent = Readonly<{
  summary: string;
  description?: string;
  location?: string;
  start: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  end: Readonly<{ date?: string; dateTime?: string; timeZone?: string }>;
  attendees?: readonly Readonly<{ email: string }>[];
}>;

export type GoogleCreateEventRequest = Readonly<{
  calendarId: string;
  providerEventId: string;
  event: GoogleWritableEvent;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleUpdateEventRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  event: GoogleWritableEvent;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleDeleteEventRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export type GoogleInvitationResponseRequest = Readonly<{
  calendarId: string;
  eventId: string;
  expectedEtag: string;
  response: "accepted" | "declined" | "tentative" | "removed";
  /** Email of the authorized account's own attendee entry (the one Google marks `self`). */
  attendeeEmail: string;
  sendUpdates: "all" | "externalOnly" | "none";
}>;

export interface GoogleCalendarPort {
  listCalendars(accessToken: string): Promise<readonly GoogleCalendarRecord[]>;
  listEvents(accessToken: string, request: GoogleListEventsRequest): Promise<GoogleEventPage>;
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEventRecord>;
  createEvent(accessToken: string, request: GoogleCreateEventRequest): Promise<GoogleEventRecord>;
  updateEvent(accessToken: string, request: GoogleUpdateEventRequest): Promise<GoogleEventRecord>;
  deleteEvent(accessToken: string, request: GoogleDeleteEventRequest): Promise<void>;
  respondToInvitation(accessToken: string, request: GoogleInvitationResponseRequest): Promise<GoogleEventRecord | void>;
}

