import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import { openConnectorDatabase, type ConnectorDatabase } from "../../src/foundation/database.js";
import { calendarBlindIndex, sealCalendarValue, type CalendarKeyring } from "../../src/calendar/crypto/envelope.js";
import type { GoogleAccessTokenProvider } from "../../src/calendar/application/google-access-token-provider.js";
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
} from "../../src/calendar/ports/google-calendar.js";
import { createCalendarRepository } from "../../src/calendar/storage/calendar-repository.js";
import type { CalendarRecord } from "../../src/calendar/storage/records.js";

/** Fictional values only: no real account, calendar, event, token or key. */
export const actorId = "00000000-0000-4000-8000-000000000021";
export const otherActorId = "00000000-0000-4000-8000-000000000022";
export const centralActorId = "00000000-0000-4000-8000-000000000023";
export const grantedScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const keyring: CalendarKeyring = {
  activeKeyId: "fictional-key",
  keys: new Map([["fictional-key", new Uint8Array(32).fill(21)]]),
  blindIndexKey: new Uint8Array(32).fill(23),
};
export const repository = createCalendarRepository();

export const humanPrincipal = (id = actorId, requestId = "request-fictional-human"): DelegatedPrincipal => ({
  serviceId: "pih-web", subject: "fictional-human", actorId: id, actorType: "human",
  scopes: ["calendar:read", "calendar:propose", "calendar:configure", "calendar:confirm"], requestId,
});
export const centralPrincipal = (id = actorId, requestId = "request-fictional-central"): DelegatedPrincipal => ({
  serviceId: "hermes-central", subject: "fictional-central", actorId: id, actorType: "agent",
  scopes: ["calendar:read", "calendar:propose"], requestId,
});

export class TestClock {
  current: Date;
  constructor(start = "2026-10-12T12:00:00.000Z") { this.current = new Date(start); }
  readonly now = (): Date => new Date(this.current);
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export type DatabaseFixture = Readonly<{ db: ConnectorDatabase; path: string; close(): Promise<void> }>;
const openFixtures: Array<() => Promise<void>> = [];
export const openTestDatabase = async (): Promise<DatabaseFixture> => {
  const dir = await mkdtemp(join(tmpdir(), "calendar-fixture-"));
  const path = join(dir, "db.sqlite");
  const db = openConnectorDatabase(path);
  await db.read(() => undefined);
  let closed = false;
  const close = async () => {
    if (!closed) { closed = true; db.close(); }
  };
  openFixtures.push(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  return { db, path, close };
};
export const reopenTestDatabase = async (path: string): Promise<ConnectorDatabase> => {
  const db = openConnectorDatabase(path);
  await db.read(() => undefined);
  openFixtures.push(async () => { db.close(); });
  return db;
};
export const closeTestDatabases = async (): Promise<void> => {
  for (const close of openFixtures.splice(0).reverse()) await close().catch(() => undefined);
};

export const calendarRefFor = (actor: string, providerCalendarId: string): string =>
  "cal_" + createHmac("sha256", keyring.blindIndexKey).update(actor + "\0" + providerCalendarId, "utf8").digest("base64url");

export const seedConnection = async (db: ConnectorDatabase, actor = actorId, now = "2026-10-12T12:00:00.000Z") => {
  await db.transaction((handle) => repository.saveConnection(handle, {
    actorId: actor, state: "available",
    refreshTokenCiphertext: sealCalendarValue("fictional-refresh-token", `calendar_connections:${actor}:refresh`, keyring),
    grantedScopes, selectionVersion: 1, createdAt: now, updatedAt: now,
  }));
};

export type SeedCalendar = Readonly<{
  providerId: string;
  displayName: string;
  isPrimary?: boolean;
  readEnabled?: boolean;
  writeEnabled?: boolean;
  role?: CalendarRecord["providerAccessRole"];
}>;
export const seedCalendars = async (
  db: ConnectorDatabase, calendars: readonly SeedCalendar[], actor = actorId, now = "2026-10-12T12:00:00.000Z",
): Promise<Record<string, string>> => {
  const refs: Record<string, string> = {};
  await db.transaction((handle) => {
    const connection = repository.getConnection(handle, actor)!;
    const records = calendars.map((calendar): CalendarRecord => {
      const calendarRef = calendarRefFor(actor, calendar.providerId);
      refs[calendar.providerId] = calendarRef;
      return {
        actorId: actor, calendarRef,
        providerCalendarIdCiphertext: sealCalendarValue(calendar.providerId, `calendar_allowlist:${actor}:provider-id`, keyring),
        providerCalendarBlindIndex: calendarBlindIndex(calendar.providerId, keyring),
        displayNameCiphertext: sealCalendarValue(calendar.displayName, `calendar_allowlist:${actor}:display-name`, keyring),
        providerAccessRole: calendar.role ?? "owner",
        readEnabled: calendar.readEnabled ?? true,
        writeEnabled: calendar.writeEnabled ?? false,
        isPrimary: calendar.isPrimary ?? false,
        lastVerifiedAt: now,
      };
    });
    repository.replaceCalendarSelection(handle, actor, connection.selectionVersion, records, connection.authorizationId, {
      now, requestId: "request-fictional-seed",
    });
  });
  return refs;
};

export const fakeTokens = (db: ConnectorDatabase): GoogleAccessTokenProvider & { calls: number } => {
  const provider = {
    calls: 0,
    async getAuthorizedAccessToken(actor: string) {
      provider.calls += 1;
      const connection = await db.read((handle) => repository.getConnection(handle, actor));
      if (connection === null) throw new Error("calendar_not_configured");
      return { accessToken: "fictional-access-token", authorizationId: connection.authorizationId };
    },
    invalidate() { /* no cache in the fake */ },
  };
  return provider;
};

export const googleEvent = (overrides: Partial<GoogleEventRecord> = {}): GoogleEventRecord => ({
  id: "fictional-event-01",
  etag: '"etag-1"',
  status: "confirmed",
  summary: "Fictional event",
  start: { dateTime: "2026-10-12T13:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-10-12T14:00:00Z", timeZone: "UTC" },
  updated: "2026-10-11T12:00:00.000Z",
  ...overrides,
});

type Failure = Readonly<{ code: string; times?: number }>;

/** In-memory Google Calendar double. It never performs network I/O. */
export class FakeGoogleCalendar implements GoogleCalendarPort {
  calendars: GoogleCalendarRecord[] = [];
  /** Provider calendar id -> pages of events returned by listEvents. */
  readonly pages = new Map<string, GoogleEventRecord[][]>();
  /** Provider calendar id -> event id -> current event (for get and mutations). */
  readonly events = new Map<string, Map<string, GoogleEventRecord>>();
  readonly listRequests: GoogleListEventsRequest[] = [];
  readonly mutations: Array<Readonly<{ kind: string; request: unknown }>> = [];
  readonly failures = new Map<string, Failure>();
  listDelayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  etagCounter = 100;
  /** When set, the next mutation of this kind succeeds at the provider but throws to the caller. */
  ambiguous = new Set<string>();

  #fail(operation: string): void {
    const failure = this.failures.get(operation);
    if (failure === undefined) return;
    if (failure.times !== undefined) {
      if (failure.times <= 1) this.failures.delete(operation);
      else this.failures.set(operation, { ...failure, times: failure.times - 1 });
    }
    throw new Error(failure.code);
  }

  put(calendarId: string, event: GoogleEventRecord): void {
    const byId = this.events.get(calendarId) ?? new Map<string, GoogleEventRecord>();
    byId.set(event.id, event);
    this.events.set(calendarId, byId);
  }

  async listCalendars(_accessToken: string): Promise<readonly GoogleCalendarRecord[]> {
    this.#fail("listCalendars");
    return this.calendars;
  }

  async listEvents(_accessToken: string, request: GoogleListEventsRequest): Promise<GoogleEventPage> {
    this.listRequests.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
      this.#fail("listEvents");
      this.#fail(`listEvents:${request.calendarId}`);
      const pages = this.pages.get(request.calendarId) ?? [[]];
      const index = request.pageToken === undefined ? 0 : Number(request.pageToken.replace("page-", ""));
      const items = pages[index] ?? [];
      return { items, ...(index + 1 < pages.length ? { nextPageToken: `page-${index + 1}` } : {}) };
    } finally {
      this.inFlight -= 1;
    }
  }

  async getEvent(_accessToken: string, calendarId: string, eventId: string): Promise<GoogleEventRecord> {
    this.#fail("getEvent");
    const event = this.events.get(calendarId)?.get(eventId);
    if (event === undefined) throw new Error("google_calendar_not_found");
    return event;
  }

  #nextEtag(): string { this.etagCounter += 1; return `"etag-${this.etagCounter}"`; }

  #requireEtag(calendarId: string, eventId: string, expectedEtag: string): GoogleEventRecord {
    const current = this.events.get(calendarId)?.get(eventId);
    if (current === undefined) throw new Error("google_calendar_not_found");
    if (current.etag !== expectedEtag) throw new Error("google_calendar_conflict");
    return current;
  }

  #maybeAmbiguous(kind: string): void {
    if (this.ambiguous.delete(kind)) throw new Error("google_calendar_temporarily_unavailable");
  }

  async createEvent(_accessToken: string, request: GoogleCreateEventRequest): Promise<GoogleEventRecord> {
    this.mutations.push({ kind: "create", request });
    this.#fail("createEvent");
    if (this.events.get(request.calendarId)?.has(request.providerEventId)) throw new Error("google_calendar_conflict");
    const created = googleEvent({
      id: request.providerEventId, etag: this.#nextEtag(), summary: request.event.summary,
      start: request.event.start, end: request.event.end, organizer: { self: true },
      ...(request.event.attendees === undefined ? {} : { attendees: request.event.attendees }),
    });
    this.put(request.calendarId, created);
    this.#maybeAmbiguous("create");
    return created;
  }

  async updateEvent(_accessToken: string, request: GoogleUpdateEventRequest): Promise<GoogleEventRecord> {
    this.mutations.push({ kind: "update", request });
    this.#fail("updateEvent");
    const current = this.#requireEtag(request.calendarId, request.eventId, request.expectedEtag);
    const updated: GoogleEventRecord = {
      ...current, etag: this.#nextEtag(), summary: request.event.summary, start: request.event.start, end: request.event.end,
      ...(request.event.description === undefined ? {} : { description: request.event.description }),
      ...(request.event.location === undefined ? {} : { location: request.event.location }),
      ...(request.event.attendees === undefined ? {} : { attendees: request.event.attendees }),
    };
    this.put(request.calendarId, updated);
    this.#maybeAmbiguous("update");
    return updated;
  }

  async deleteEvent(_accessToken: string, request: GoogleDeleteEventRequest): Promise<void> {
    this.mutations.push({ kind: "delete", request });
    this.#fail("deleteEvent");
    this.#requireEtag(request.calendarId, request.eventId, request.expectedEtag);
    this.events.get(request.calendarId)!.delete(request.eventId);
    this.#maybeAmbiguous("delete");
  }

  async respondToInvitation(_accessToken: string, request: GoogleInvitationResponseRequest): Promise<GoogleEventRecord | void> {
    this.mutations.push({ kind: "respond", request });
    this.#fail("respondToInvitation");
    const current = this.#requireEtag(request.calendarId, request.eventId, request.expectedEtag);
    if (request.response === "removed") {
      this.events.get(request.calendarId)!.delete(request.eventId);
      this.#maybeAmbiguous("respond");
      return;
    }
    const updated: GoogleEventRecord = {
      ...current, etag: this.#nextEtag(),
      attendees: (current.attendees ?? []).map((attendee) => attendee.email === request.attendeeEmail
        ? { ...attendee, responseStatus: request.response as "accepted" | "declined" | "tentative" } : attendee),
    };
    this.put(request.calendarId, updated);
    this.#maybeAmbiguous("respond");
    return updated;
  }
}
