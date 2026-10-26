import { randomUUID } from "node:crypto";

import type { CalendarChangeProposal } from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import { calendarBlindIndex, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import { deriveEventRef } from "../domain/google-event-mapper.js";
import { providerEventIdForProposal } from "../domain/provider-event-id.js";
import type { GoogleCalendarPort, GoogleCalendarRecord, GoogleEventRecord, GoogleWritableEvent } from "../ports/google-calendar.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarRecord, ProposalRecord } from "../storage/records.js";
import { eventReferenceAad, type CalendarEventReader, type OpenedCalendar } from "./calendar-event-reader.js";
import { safeProviderError } from "./connection-health.js";
import type { AuthorizedAccessToken } from "./google-access-token-provider.js";
import { openProposalEtag, openProposalPayload, type ProposalPayload } from "./proposal-payload.js";

type SafeReason = CalendarChangeProposal["safeReasonCode"];
type Outcome =
  | Readonly<{ kind: "completed"; createdProviderEventId?: string }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "failed"; reason?: SafeReason }>
  /** The provider state could not be determined; the proposal stays executing for reconciliation. */
  | Readonly<{ kind: "unknown" }>;
type Mode = "execute" | "recover";
type Context = Readonly<{
  proposal: ProposalRecord;
  payload: ProposalPayload;
  originalEtag: string | undefined;
  calendar: CalendarRecord;
  opened: OpenedCalendar;
  token: AuthorizedAccessToken;
  requestId: string;
}>;

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  reader: CalendarEventReader;
  google: GoogleCalendarPort;
  keyring: CalendarKeyring;
  clock: () => Date;
}>;

const fail = (code: string): never => { throw new Error(code); };
const COMPLETED: Outcome = { kind: "completed" };
const CONFLICT: Outcome = { kind: "conflict" };
const UNKNOWN: Outcome = { kind: "unknown" };
const canWrite = (role: GoogleCalendarRecord["accessRole"]): boolean => role === "writer" || role === "owner";
const storedRole = (role: GoogleCalendarRecord["accessRole"]): CalendarRecord["providerAccessRole"] =>
  role === "freeBusyReader" ? "free_busy_reader" : role;

/** Errors after which the provider certainly did not apply the mutation. */
const isDefinitive = (code: string): boolean =>
  code === "google_calendar_permission_denied" || code === "google_calendar_reauthorization_required" ||
  code === "calendar_reauthorization_required" || code === "google_calendar_request_invalid";
const definitiveReason = (code: string): SafeReason =>
  code === "google_calendar_request_invalid" ? undefined : "provider_permission_denied";
const isGone = (event: GoogleEventRecord | "absent"): event is "absent" => event === "absent";
const sameTime = (left: GoogleWritableEvent["start"], right: GoogleWritableEvent["start"]): boolean => {
  if (left.dateTime !== undefined && right.dateTime !== undefined) return Date.parse(left.dateTime) === Date.parse(right.dateTime);
  return left.date !== undefined && left.date === right.date;
};
/** True when the provider already shows the proposal's intended after-state. */
const matchesIntended = (current: GoogleEventRecord, intended: GoogleWritableEvent): boolean =>
  (current.summary ?? "") === intended.summary &&
  sameTime(current.start, intended.start) && sameTime(current.end, intended.end) &&
  (intended.description === undefined || current.description === intended.description) &&
  (intended.location === undefined || current.location === intended.location);
const selfAttendee = (event: GoogleEventRecord, email: string | undefined) =>
  email === undefined ? undefined : event.attendees?.find((attendee) => attendee.self === true && attendee.email === email);

/**
 * Applies a confirmed proposal at the provider and persists exactly one terminal transition.
 * Every mutation is preceded by an authorization compare-and-swap, a fresh provider role check,
 * and, for existing events, an ETag and ownership check. Ambiguous provider responses are resolved
 * by reading provider state, never by a second blind mutation.
 */
export class CalendarChangeExecutor {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #reader: CalendarEventReader;
  readonly #google: GoogleCalendarPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: () => Date;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#reader = options.reader;
    this.#google = options.google;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
  }

  /** First execution right after the pending -> executing compare-and-set. */
  execute(proposal: ProposalRecord, token: AuthorizedAccessToken, requestId: string): Promise<ProposalRecord> {
    return this.#run(proposal, async () => token, requestId, "execute");
  }

  /** Settles a proposal found executing with unknown provider state (crash, ambiguous response). */
  recover(proposal: ProposalRecord, requestId: string): Promise<ProposalRecord> {
    return this.#run(proposal, () => this.#reader.token(proposal.actorId), requestId, "recover");
  }

  async #run(
    proposal: ProposalRecord, token: () => Promise<AuthorizedAccessToken>, requestId: string, mode: Mode,
  ): Promise<ProposalRecord> {
    if (proposal.status !== "executing") return proposal;
    const operation = proposal.operation;
    // A detached proposal lost its live event reference (deselection or purge): it never executes.
    if (proposal.eventRef === undefined && proposal.retainedEventRef !== undefined) {
      return this.#settle(proposal, CONFLICT, requestId, "provider_state_changed");
    }
    const payload = openProposalPayload(proposal, this.#keyring);
    const calendar = await this.#database.read((db) => this.#repository.resolveCalendar(db, proposal.actorId, payload.calendarRef));
    if (calendar === null || (mode === "execute" && !calendar.writeEnabled)) {
      // Before the first attempt nothing was sent, so a withdrawn approval is a clean failure. During
      // recovery a deselected calendar can no longer be inspected, so the outcome needs human review.
      return mode === "execute"
        ? this.#settle(proposal, { kind: "failed", reason: "provider_permission_denied" }, requestId)
        : this.#settle(proposal, CONFLICT, requestId, "provider_state_changed");
    }
    const context: Context = {
      proposal, payload, originalEtag: openProposalEtag(proposal, this.#keyring), calendar,
      opened: this.#reader.openCalendar(calendar), token: await token(), requestId,
    };
    const outcome = operation === "create"
      ? await this.#create(context, mode, mode === "execute" ? 2 : 1)
      : await this.#eventOperation(context, mode, mode === "execute" ? 2 : 1);
    if (outcome.kind === "unknown") {
      return (await this.#database.read((db) => this.#repository.getProposal(db, proposal.actorId, proposal.id))) ?? proposal;
    }
    if (outcome.kind === "completed") await this.#reader.health.recordSuccess(proposal.actorId, context.token.authorizationId);
    return this.#settle(proposal, outcome, requestId, outcome.kind === "conflict" ? "provider_state_changed" : undefined);
  }

  async #create(context: Context, mode: Mode, budget: number): Promise<Outcome> {
    const providerEventId = providerEventIdForProposal(context.proposal.id);
    const completed: Outcome = { kind: "completed", createdProviderEventId: providerEventId };
    if (mode === "recover") {
      const found = await this.#fetch(context, providerEventId);
      if (found === "unknown") return UNKNOWN;
      if (!isGone(found)) return completed;
    }
    if (budget === 0) return UNKNOWN;
    const gate = await this.#authorizeWrite(context);
    if (gate !== null) return gate;
    try {
      await this.#google.createEvent(context.token.accessToken, {
        calendarId: context.opened.providerCalendarId, providerEventId, event: context.payload.event ?? fail("calendar_proposal_payload_invalid"),
        sendUpdates: context.payload.sendUpdates,
      });
      return completed;
    } catch (error) {
      const code = await this.#noteFailure(context, error);
      if (isDefinitive(code)) return { kind: "failed", reason: definitiveReason(code) };
      // The deterministic id makes the outcome observable: look it up instead of creating blindly.
      return this.#create(context, "recover", budget - 1);
    }
  }

  async #eventOperation(context: Context, mode: Mode, budget: number): Promise<Outcome> {
    const { payload, originalEtag, proposal } = context;
    const targetId = payload.targetProviderEventId ?? fail("calendar_proposal_payload_invalid");
    const current = await this.#fetch(context, targetId);
    if (current === "unknown") return mode === "execute" ? { kind: "failed", reason: "provider_temporarily_unavailable" } : UNKNOWN;
    const gone = isGone(current) || current.status === "cancelled";
    const removes = proposal.operation === "cancel" || (proposal.operation === "respond_invitation" && payload.response === "removed");

    if (mode === "recover") {
      if (removes && gone) return COMPLETED;
      if (!gone && proposal.operation === "update" && current.etag !== originalEtag &&
          matchesIntended(current, payload.event ?? fail("calendar_proposal_payload_invalid"))) return COMPLETED;
      if (!gone && proposal.operation === "respond_invitation" && !removes &&
          selfAttendee(current, payload.attendeeEmail)?.responseStatus === payload.response) return COMPLETED;
    }
    if (gone || current.etag !== originalEtag) return CONFLICT;
    const ownership = this.#ownership(context, current);
    if (ownership !== null) return ownership;
    if (budget === 0) return UNKNOWN;
    const gate = await this.#authorizeWrite(context);
    if (gate !== null) return gate;

    try {
      await this.#mutate(context, targetId, current.etag);
      return COMPLETED;
    } catch (error) {
      const code = await this.#noteFailure(context, error);
      if (code === "google_calendar_not_found") return removes ? COMPLETED : CONFLICT;
      if (code === "google_calendar_conflict") return CONFLICT;
      if (isDefinitive(code)) return { kind: "failed", reason: definitiveReason(code) };
      return this.#eventOperation(context, "recover", budget - 1);
    }
  }

  /** Cancelling is only for events the actor organizes; responding only for someone else's invitation. */
  #ownership(context: Context, current: GoogleEventRecord): Outcome | null {
    const organizedBySelf = current.organizer?.self === true;
    switch (context.proposal.operation) {
      case "cancel":
        return organizedBySelf ? null : { kind: "failed", reason: "cancel_not_permitted" };
      case "update":
        return organizedBySelf ? null : CONFLICT;
      case "respond_invitation":
        return !organizedBySelf && selfAttendee(current, context.payload.attendeeEmail) !== undefined ? null : CONFLICT;
      default:
        return CONFLICT;
    }
  }

  async #mutate(context: Context, eventId: string, etag: string): Promise<void> {
    const { payload, opened, token } = context;
    const common = { calendarId: opened.providerCalendarId, eventId, expectedEtag: etag, sendUpdates: payload.sendUpdates };
    switch (context.proposal.operation) {
      case "update":
        await this.#google.updateEvent(token.accessToken, { ...common, event: payload.event ?? fail("calendar_proposal_payload_invalid") });
        return;
      case "cancel":
        await this.#google.deleteEvent(token.accessToken, common);
        return;
      case "respond_invitation":
        await this.#google.respondToInvitation(token.accessToken, {
          ...common,
          response: payload.response ?? fail("calendar_proposal_payload_invalid"),
          attendeeEmail: payload.attendeeEmail ?? fail("calendar_proposal_payload_invalid"),
        });
        return;
      default:
        fail("calendar_proposal_payload_invalid");
    }
  }

  async #fetch(context: Context, eventId: string): Promise<GoogleEventRecord | "absent" | "unknown"> {
    try {
      return await this.#google.getEvent(context.token.accessToken, context.opened.providerCalendarId, eventId);
    } catch (error) {
      if (safeProviderError(error) === "google_calendar_not_found") return "absent";
      await this.#noteFailure(context, error);
      return "unknown";
    }
  }

  /**
   * Immediately before a provider write: the token must still belong to the stored authorization
   * (compare-and-swap on authorization_id), and Google must still report writer or owner. A
   * downgraded role disables write in the stored allowlist.
   */
  async #authorizeWrite(context: Context): Promise<Outcome | null> {
    const { proposal, token } = context;
    const stored = await this.#database.read((db) => ({
      connection: this.#repository.getConnection(db, proposal.actorId),
      calendar: this.#repository.resolveCalendar(db, proposal.actorId, context.calendar.calendarRef),
    }));
    if (stored.connection === null || stored.connection.authorizationId !== token.authorizationId) return fail("calendar_connection_changed");
    if (stored.calendar === null || !stored.calendar.writeEnabled) return { kind: "failed", reason: "provider_permission_denied" };
    let calendars: readonly GoogleCalendarRecord[];
    try {
      calendars = await this.#google.listCalendars(token.accessToken);
    } catch (error) {
      const code = await this.#noteFailure(context, error);
      return { kind: "failed", reason: isDefinitive(code) ? definitiveReason(code) : "provider_temporarily_unavailable" };
    }
    const provider = calendars.find((item) => item.id === context.opened.providerCalendarId);
    if (provider !== undefined && canWrite(provider.accessRole)) return null;
    await this.#disableWrite(context, provider?.accessRole);
    return { kind: "failed", reason: "provider_permission_denied" };
  }

  async #disableWrite(context: Context, role: GoogleCalendarRecord["accessRole"] | undefined): Promise<void> {
    const { proposal, token } = context;
    const now = this.#clock().toISOString();
    await this.#database.transaction((db) => {
      const connection = this.#repository.getConnection(db, proposal.actorId);
      if (connection === null || connection.authorizationId !== token.authorizationId) return;
      const calendars = this.#repository.listCalendars(db, proposal.actorId).map((record) => record.calendarRef === context.calendar.calendarRef
        ? { ...record, writeEnabled: false, lastVerifiedAt: now, ...(role === undefined ? {} : { providerAccessRole: storedRole(role) }) }
        : record);
      const selected = calendars.filter((record) => record.readEnabled || record.writeEnabled);
      // Never break the primary invariant; the provider check alone already blocks this write.
      if (selected.filter((record) => record.isPrimary).length !== 1) return;
      this.#repository.replaceCalendarSelection(db, proposal.actorId, connection.selectionVersion, calendars, token.authorizationId, {
        now, requestId: context.requestId,
      });
      this.#repository.appendAudit(db, {
        id: randomUUID(), actorId: proposal.actorId, operation: "selection_change", outcome: "selection_updated",
        requestId: context.requestId, occurredAt: now,
      });
    });
  }

  async #noteFailure(context: Context, error: unknown): Promise<string> {
    const code = safeProviderError(error);
    await this.#reader.health.recordFailure(context.proposal.actorId, context.token.authorizationId, error);
    return code;
  }

  /** Persists one terminal transition plus its content-free audit row; detached proposals settle via their retained reference. */
  async #settle(proposal: ProposalRecord, outcome: Outcome, requestId: string, reason?: SafeReason): Promise<ProposalRecord> {
    const to = outcome.kind === "completed" ? "completed" : outcome.kind === "conflict" ? "conflict" : "failed";
    const safeReasonCode = outcome.kind === "failed" ? outcome.reason : reason;
    const now = this.#clock().toISOString();
    return this.#database.transaction((db) => {
      const current = this.#repository.getProposal(db, proposal.actorId, proposal.id);
      if (current === null) return fail("calendar_proposal_not_found");
      if (current.status !== "executing") return current;
      let eventRef: string | undefined;
      if (current.eventRef === undefined && current.retainedEventRef !== undefined) {
        eventRef = current.retainedEventRef;
      } else if (outcome.kind === "completed" && outcome.createdProviderEventId !== undefined) {
        eventRef = this.#retainCreatedReference(db, current, outcome.createdProviderEventId, now);
      }
      const settled = this.#repository.transitionProposal(db, {
        actorId: current.actorId, proposalId: current.id, expectedVersion: current.version, from: ["executing"], to,
        completedAt: now,
        ...(eventRef === undefined ? {} : { eventRef }),
        ...(safeReasonCode === undefined ? {} : { safeReasonCode }),
      });
      this.#repository.appendAudit(db, {
        id: randomUUID(), actorId: current.actorId, proposalId: current.id, operation: current.operation, outcome: to,
        requestId, occurredAt: now,
      });
      return settled;
    });
  }

  #retainCreatedReference(
    db: Parameters<Parameters<ConnectorDatabase["transaction"]>[0]>[0], proposal: ProposalRecord, providerEventId: string, now: string,
  ): string | undefined {
    const payload = openProposalPayload(proposal, this.#keyring);
    if (this.#repository.resolveCalendar(db, proposal.actorId, payload.calendarRef) === null) return undefined;
    const eventRef = deriveEventRef(this.#keyring.blindIndexKey, proposal.actorId, payload.calendarRef, providerEventId);
    this.#repository.upsertEventReference(db, {
      actorId: proposal.actorId, eventRef, calendarRef: payload.calendarRef,
      providerEventIdCiphertext: sealCalendarValue(providerEventId, eventReferenceAad(proposal.actorId), this.#keyring),
      providerEventBlindIndex: calendarBlindIndex(providerEventId, this.#keyring),
      lastObservedAt: now,
    });
    return eventRef;
  }
}
