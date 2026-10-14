import type { CalendarEventDetail } from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import { calendarBlindIndex, openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import { compareCalendarEvents, deriveEventRef, mapGoogleEvent } from "../domain/google-event-mapper.js";
import type { GoogleCalendarPort } from "../ports/google-calendar.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarRecord, EventReferenceRecord } from "../storage/records.js";
import { CalendarConnectionHealth, publicProviderError } from "./connection-health.js";
import type { AuthorizedAccessToken, GoogleAccessTokenProvider } from "./google-access-token-provider.js";

export type CalendarReadWindow = Readonly<{ from: string; to: string; timeZone: string }>;

/** A selected calendar with its private provider identifier opened for a single provider call. */
export type OpenedCalendar = Readonly<{
  record: CalendarRecord;
  providerCalendarId: string;
  displayName: string;
}>;

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  tokens: GoogleAccessTokenProvider;
  google: GoogleCalendarPort;
  keyring: CalendarKeyring;
  clock: () => Date;
  /** Provider reads in flight at once; fixed at four in production. */
  maxConcurrency?: number;
}>;

const MAX_PAGES_PER_CALENDAR = 64;
const fail = (code: string): never => { throw new Error(code); };
const isCode = (error: unknown, code: string): boolean => error instanceof Error && error.message === code;

export const calendarAllowlistAad = (actorId: string, field: "provider-id" | "display-name"): string =>
  `calendar_allowlist:${actorId}:${field}`;
export const eventReferenceAad = (actorId: string): string => `calendar_event_refs:${actorId}:provider-id`;

type Collected = Readonly<{ detail: CalendarEventDetail; providerEventId: string }>;

/**
 * Reads events from the actor's read-enabled calendars only. Results are mapped to safe contract
 * values before anything is retained; raw provider payloads and tokens are never cached. Every
 * opaque event reference written here is bound to the authorization that produced the read.
 */
export class CalendarEventReader {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #google: GoogleCalendarPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: () => Date;
  readonly #maxConcurrency: number;
  readonly health: CalendarConnectionHealth;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#tokens = options.tokens;
    this.#google = options.google;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
    this.#maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isInteger(this.#maxConcurrency) || this.#maxConcurrency < 1 || this.#maxConcurrency > 4) {
      fail("calendar_read_concurrency_invalid");
    }
    this.health = new CalendarConnectionHealth(options);
  }

  /** Returns at most `maxItems` mapped events in stable chronological order, or fails as too large. */
  async collect(actorId: string, window: CalendarReadWindow, maxItems: number): Promise<readonly CalendarEventDetail[]> {
    const calendars = (await this.#database.read((db) => this.#repository.listCalendars(db, actorId)))
      .filter((calendar) => calendar.readEnabled)
      .map((record) => this.openCalendar(record));
    if (calendars.length === 0) {
      const connection = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
      return connection === null ? fail("calendar_not_configured") : [];
    }
    const token = await this.token(actorId);
    const collected = new Map<string, Collected>();
    const state = { mapped: 0, stopped: false };
    const queue = [...calendars];

    const readCalendar = async (calendar: OpenedCalendar): Promise<void> => {
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_CALENDAR; page += 1) {
        if (state.stopped) return;
        let result;
        try {
          result = await this.#google.listEvents(token.accessToken, {
            calendarId: calendar.providerCalendarId, timeMin: window.from, timeMax: window.to, timeZone: window.timeZone,
            ...(pageToken === undefined ? {} : { pageToken }),
          });
        } catch (error) {
          // A calendar deleted at the provider contributes nothing instead of failing every other calendar.
          if (isCode(error, "google_calendar_not_found")) return;
          throw error;
        }
        if (state.stopped) return;
        for (const event of result.items) {
          const eventRef = deriveEventRef(this.#keyring.blindIndexKey, actorId, calendar.record.calendarRef, event.id);
          const detail = mapGoogleEvent(event, {
            eventRef, calendarRef: calendar.record.calendarRef, calendarDisplayName: calendar.displayName, timeZone: window.timeZone,
          });
          if (detail === null) continue;
          state.mapped += 1;
          if (state.mapped > maxItems) {
            state.stopped = true;
            fail("calendar_result_too_large");
          }
          if (!collected.has(eventRef)) collected.set(eventRef, { detail, providerEventId: event.id });
        }
        if (result.nextPageToken === undefined) return;
        if (seenTokens.has(result.nextPageToken)) fail("google_calendar_response_invalid");
        seenTokens.add(result.nextPageToken);
        pageToken = result.nextPageToken;
      }
      fail("google_calendar_response_invalid");
    };
    const worker = async (): Promise<void> => {
      try {
        while (!state.stopped) {
          const calendar = queue.shift();
          if (calendar === undefined) return;
          await readCalendar(calendar);
        }
      } catch (error) {
        state.stopped = true;
        throw error;
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(this.#maxConcurrency, calendars.length) }, worker));
    } catch (error) {
      if (isCode(error, "calendar_result_too_large")) throw error;
      await this.health.recordFailure(actorId, token.authorizationId, error);
      throw publicProviderError(error);
    }

    const retained = await this.#retainReferences(actorId, token, [...collected.values()]);
    await this.health.recordSuccess(actorId, token.authorizationId);
    return retained.sort((left, right) => compareCalendarEvents(left, right, window.timeZone));
  }

  /** Re-reads one event by opaque reference from a still read-enabled calendar of the same actor. */
  async readOne(actorId: string, eventRef: string, timeZone = "UTC"): Promise<CalendarEventDetail> {
    const resolved = await this.resolveReadable(actorId, eventRef);
    const token = await this.token(actorId);
    let event;
    try {
      event = await this.#google.getEvent(token.accessToken, resolved.calendar.providerCalendarId, resolved.providerEventId);
    } catch (error) {
      if (isCode(error, "google_calendar_not_found")) return fail("calendar_event_not_found");
      await this.health.recordFailure(actorId, token.authorizationId, error);
      throw publicProviderError(error);
    }
    const detail = mapGoogleEvent(event, {
      eventRef, calendarRef: resolved.calendar.record.calendarRef, calendarDisplayName: resolved.calendar.displayName, timeZone,
    });
    if (detail === null || event.id !== resolved.providerEventId) return fail("calendar_event_not_found");
    await this.#retainReferences(actorId, token, [{ detail, providerEventId: resolved.providerEventId }]);
    await this.health.recordSuccess(actorId, token.authorizationId);
    return detail;
  }

  /** Resolves an actor-owned reference whose calendar is still read-enabled; anything else is not found. */
  async resolveReadable(actorId: string, eventRef: string): Promise<Readonly<{
    reference: EventReferenceRecord; calendar: OpenedCalendar; providerEventId: string;
  }>> {
    const found = await this.#database.read((db) => {
      const reference = this.#repository.resolveEvent(db, actorId, eventRef);
      if (reference === null) return null;
      const calendar = this.#repository.resolveCalendar(db, actorId, reference.calendarRef);
      return calendar === null || !calendar.readEnabled ? null : { reference, calendar };
    });
    if (found === null) return fail("calendar_event_not_found");
    return {
      reference: found.reference,
      calendar: this.openCalendar(found.calendar),
      providerEventId: openCalendarValue(found.reference.providerEventIdCiphertext, eventReferenceAad(actorId), this.#keyring),
    };
  }

  openCalendar(record: CalendarRecord): OpenedCalendar {
    return {
      record,
      providerCalendarId: openCalendarValue(record.providerCalendarIdCiphertext, calendarAllowlistAad(record.actorId, "provider-id"), this.#keyring),
      displayName: openCalendarValue(record.displayNameCiphertext, calendarAllowlistAad(record.actorId, "display-name"), this.#keyring),
    };
  }

  /** Obtains an access token bound to its authorization id; failures update safe health first. */
  async token(actorId: string): Promise<AuthorizedAccessToken> {
    const before = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (before === null) return fail("calendar_not_configured");
    try {
      return await this.#tokens.getAuthorizedAccessToken(actorId);
    } catch (error) {
      await this.health.recordFailure(actorId, before.authorizationId, error);
      throw publicProviderError(error);
    }
  }

  /**
   * Persists opaque references for mapped events in one transaction bound to the authorization
   * that produced the read. Events whose calendar stopped being readable meanwhile are dropped.
   */
  async #retainReferences(
    actorId: string, token: AuthorizedAccessToken, items: readonly Collected[],
  ): Promise<CalendarEventDetail[]> {
    if (items.length === 0) return [];
    const observedAt = this.#clock().toISOString();
    return this.#database.transaction((db) => {
      const connection = this.#repository.getConnection(db, actorId);
      if (connection === null || connection.authorizationId !== token.authorizationId) fail("calendar_connection_changed");
      const readable = new Set(this.#repository.listCalendars(db, actorId)
        .filter((calendar) => calendar.readEnabled).map((calendar) => calendar.calendarRef));
      const kept: CalendarEventDetail[] = [];
      for (const item of items) {
        if (!readable.has(item.detail.calendarRef)) continue;
        this.#repository.upsertEventReference(db, {
          actorId, eventRef: item.detail.eventRef, calendarRef: item.detail.calendarRef,
          providerEventIdCiphertext: sealCalendarValue(item.providerEventId, eventReferenceAad(actorId), this.#keyring),
          providerEventBlindIndex: calendarBlindIndex(item.providerEventId, this.#keyring),
          lastObservedAt: observedAt,
        });
        kept.push(item.detail);
      }
      return kept;
    });
  }
}
