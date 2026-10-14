import { createHash, randomUUID } from "node:crypto";

import {
  ConfirmCalendarChangeProposalBodySchema,
  CreateCalendarChangeProposalBodySchema,
  RejectCalendarChangeProposalBodySchema,
  type CalendarChangeProposal,
  type CalendarChangeSummary,
  type CalendarEventDetail,
  type CalendarEventDraft,
  type CalendarEventTime,
  type ConfirmCalendarChangeProposalBody,
  type CreateCalendarChangeProposalBody,
  type DelegatedPrincipal,
  type RejectCalendarChangeProposalBody,
} from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import type { CalendarKeyring } from "../crypto/envelope.js";
import { mapGoogleEvent, sanitizeExternalText, toEventPreview } from "../domain/google-event-mapper.js";
import type { GoogleCalendarPort, GoogleCalendarRecord, GoogleEventRecord, GoogleWritableEvent } from "../ports/google-calendar.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarRecord, ProposalRecord } from "../storage/records.js";
import type { CalendarEventReader, OpenedCalendar } from "./calendar-event-reader.js";
import { CalendarChangeExecutor } from "./change-executor.js";
import { publicProviderError } from "./connection-health.js";
import { CalendarExecutionReconciler } from "./execution-reconciler.js";
import type { AuthorizedAccessToken } from "./google-access-token-provider.js";
import { KeyedMutex, proposalLockKey } from "./keyed-mutex.js";
import {
  proposalView,
  sealProposalEtag,
  sealProposalPayload,
  type ProposalPayload,
  type SendUpdates,
} from "./proposal-payload.js";

export interface CalendarChangeProposalService {
  create(
    principal: DelegatedPrincipal,
    idempotencyKey: string,
    body: CreateCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  get(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal>;
  confirm(
    principal: DelegatedPrincipal,
    proposalId: string,
    body: ConfirmCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  reject(
    principal: DelegatedPrincipal,
    proposalId: string,
    body: RejectCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal>;
  reconcileExecuting(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal>;
}

type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  reader: CalendarEventReader;
  google: GoogleCalendarPort;
  keyring: CalendarKeyring;
  clock: () => Date;
  idGenerator: () => string;
  executor: CalendarChangeExecutor;
  reconciler: CalendarExecutionReconciler;
  locks: KeyedMutex;
  /** Validated configuration range 300..1800; production value 900 (15 minutes). */
  proposalTtlSeconds?: number;
}>;

type Built = Readonly<{
  calendar: CalendarRecord;
  eventRef?: string;
  payload: ProposalPayload;
  etag?: string;
}>;

const fail = (code: string): never => { throw new Error(code); };
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/u;
const TERMINAL = new Set<ProposalRecord["status"]>(["completed", "rejected", "expired", "conflict", "failed"]);
const sendUpdatesFor = (notification: "all" | "external_only" | "none"): SendUpdates =>
  notification === "external_only" ? "externalOnly" : notification;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const validTimeZone = (timeZone: string | undefined): timeZone is string => {
  if (timeZone === undefined || timeZone.length === 0 || timeZone.length > 120) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};
const canWrite = (role: GoogleCalendarRecord["accessRole"]): boolean => role === "writer" || role === "owner";
const googleTimes = (time: CalendarEventTime): Pick<GoogleWritableEvent, "start" | "end"> => time.kind === "timed"
  ? { start: { dateTime: time.start, timeZone: time.timeZone }, end: { dateTime: time.end, timeZone: time.timeZone } }
  : { start: { date: time.startDate }, end: { date: time.endDateExclusive } };
const writableFromDraft = (draft: CalendarEventDraft): GoogleWritableEvent => ({
  summary: draft.title,
  ...(draft.description === undefined ? {} : { description: draft.description }),
  ...(draft.location === undefined ? {} : { location: draft.location }),
  ...googleTimes(draft.time),
  ...(draft.attendees.length === 0 ? {} : { attendees: draft.attendees.map((attendee) => ({ email: attendee.email })) }),
});

/** Who may do what. Agent-generated text never reaches this decision: only the verified principal does. */
const requirePropose = (principal: DelegatedPrincipal): void => {
  if (!principal.scopes.includes("calendar:propose")) fail("forbidden");
};
const requireView = (principal: DelegatedPrincipal): void => {
  if (!principal.scopes.includes("calendar:propose") && !principal.scopes.includes("calendar:read")) fail("forbidden");
};
/** First release: only an authenticated human acting through pih-web may confirm, reject or retry. */
const requireHumanConfirmation = (principal: DelegatedPrincipal): void => {
  if (principal.serviceId !== "pih-web" || principal.actorType !== "human" || !principal.scopes.includes("calendar:confirm")) {
    fail("forbidden");
  }
};

/**
 * Durable change proposals. Creation never touches provider state; execution happens only after
 * an authenticated PIH confirmation and only once (pending -> executing compare-and-set).
 */
export class CalendarChangeProposalServiceImpl implements CalendarChangeProposalService {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #reader: CalendarEventReader;
  readonly #google: GoogleCalendarPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #executor: CalendarChangeExecutor;
  readonly #reconciler: CalendarExecutionReconciler;
  readonly #locks: KeyedMutex;
  readonly #ttlMs: number;

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#reader = options.reader;
    this.#google = options.google;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
    this.#idGenerator = options.idGenerator;
    this.#executor = options.executor;
    this.#reconciler = options.reconciler;
    this.#locks = options.locks;
    const ttl = options.proposalTtlSeconds ?? 900;
    if (!Number.isInteger(ttl) || ttl < 300 || ttl > 1800) fail("calendar_proposal_ttl_invalid");
    this.#ttlMs = ttl * 1000;
  }

  async create(
    principal: DelegatedPrincipal, idempotencyKey: string, body: CreateCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal> {
    requirePropose(principal);
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) return fail("idempotency_key_invalid");
    const parsed = CreateCalendarChangeProposalBodySchema.safeParse(body);
    if (!parsed.success) return fail("calendar_proposal_invalid");
    const actorId = principal.actorId;
    const keyHash = sha256(`${actorId}\0${idempotencyKey}`);
    const requestHash = sha256(canonicalJson(parsed.data));

    const previous = await this.#database.read((db) => this.#repository.findProposalByIdempotencyKey(db, actorId, keyHash));
    if (previous !== null) {
      if (previous.requestHash !== requestHash) return fail("idempotency_conflict");
      return this.#view(await this.#expireIfDue(previous.proposal, principal.requestId));
    }

    const token = await this.#reader.token(actorId);
    const built = await this.#build(actorId, parsed.data, token);
    const id = this.#idGenerator();
    const now = this.#clock();
    const record: ProposalRecord = {
      actorId, id, version: 1, status: "pending", operation: parsed.data.operation,
      ...(built.eventRef === undefined ? {} : { eventRef: built.eventRef }),
      encryptedPayload: sealProposalPayload(actorId, id, built.payload, this.#keyring),
      ...(built.etag === undefined ? {} : { providerEtagCiphertext: sealProposalEtag(actorId, id, built.etag, this.#keyring) }),
      createdByActorType: principal.actorType,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    const stored = await this.#database.transaction((db) => {
      const connection = this.#repository.getConnection(db, actorId);
      if (connection === null || connection.authorizationId !== token.authorizationId) return fail("calendar_connection_changed");
      const calendar = this.#repository.resolveCalendar(db, actorId, built.calendar.calendarRef);
      if (calendar === null || !calendar.writeEnabled) return fail("calendar_not_writable");
      const result = this.#repository.insertProposal(db, record, keyHash, requestHash);
      if (result.kind === "conflict") return fail("idempotency_conflict");
      if (result.kind === "inserted") {
        this.#repository.appendAudit(db, {
          id: randomUUID(), actorId, proposalId: id, operation: record.operation, outcome: "proposed",
          requestId: principal.requestId, occurredAt: record.createdAt,
        });
      }
      return result.proposal;
    });
    await this.#reader.health.recordSuccess(actorId, token.authorizationId);
    return this.#view(stored);
  }

  async get(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal> {
    requireView(principal);
    const record = await this.#load(principal.actorId, proposalId);
    return this.#view(await this.#expireIfDue(record, principal.requestId));
  }

  async confirm(
    principal: DelegatedPrincipal, proposalId: string, body: ConfirmCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal> {
    requireHumanConfirmation(principal);
    const parsed = ConfirmCalendarChangeProposalBodySchema.safeParse(body);
    if (!parsed.success) return fail("calendar_proposal_invalid");
    return this.#locks.run(proposalLockKey(principal.actorId, proposalId), async () => {
      const record = await this.#expireIfDue(await this.#load(principal.actorId, proposalId), principal.requestId);
      if (record.encryptedPayload === undefined) return fail("proposal_content_purged");
      if (TERMINAL.has(record.status)) return this.#view(record);
      if (record.status === "executing") {
        return this.#view(await this.#reconciler.settleWhileLocked(record, principal.requestId));
      }
      if (record.version !== parsed.data.expectedVersion) return fail("calendar_proposal_version_conflict");
      const token = await this.#reader.token(principal.actorId);
      const executing = await this.#database.transaction((db) => {
        // Compare-and-swap on the authorization that issued the token, then on the proposal itself.
        const connection = this.#repository.getConnection(db, principal.actorId);
        if (connection === null || connection.authorizationId !== token.authorizationId) return fail("calendar_connection_changed");
        return this.#repository.transitionProposal(db, {
          actorId: principal.actorId, proposalId, expectedVersion: record.version, from: ["pending"], to: "executing",
        });
      });
      return this.#view(await this.#executor.execute(executing, token, principal.requestId));
    });
  }

  async reject(
    principal: DelegatedPrincipal, proposalId: string, body: RejectCalendarChangeProposalBody,
  ): Promise<CalendarChangeProposal> {
    requireHumanConfirmation(principal);
    const parsed = RejectCalendarChangeProposalBodySchema.safeParse(body);
    if (!parsed.success) return fail("calendar_proposal_invalid");
    return this.#locks.run(proposalLockKey(principal.actorId, proposalId), async () => {
      const record = await this.#expireIfDue(await this.#load(principal.actorId, proposalId), principal.requestId);
      if (record.encryptedPayload === undefined) return fail("proposal_content_purged");
      if (TERMINAL.has(record.status)) return this.#view(record);
      if (record.status !== "pending") return fail("calendar_proposal_not_pending");
      if (record.version !== parsed.data.expectedVersion) return fail("calendar_proposal_version_conflict");
      const now = this.#clock().toISOString();
      const rejected = await this.#database.transaction((db) => {
        const next = this.#repository.transitionProposal(db, {
          actorId: record.actorId, proposalId, expectedVersion: record.version, from: ["pending"], to: "rejected", completedAt: now,
        });
        this.#repository.appendAudit(db, {
          id: randomUUID(), actorId: record.actorId, proposalId, operation: record.operation, outcome: "rejected",
          requestId: principal.requestId, occurredAt: now,
        });
        return next;
      });
      return this.#view(rejected);
    });
  }

  async reconcileExecuting(principal: DelegatedPrincipal, proposalId: string): Promise<CalendarChangeProposal> {
    requireHumanConfirmation(principal);
    return this.#locks.run(proposalLockKey(principal.actorId, proposalId), async () => {
      const record = await this.#load(principal.actorId, proposalId);
      if (record.status !== "executing") return this.#view(record);
      return this.#view(await this.#reconciler.settleWhileLocked(record, principal.requestId));
    });
  }

  async #load(actorId: string, proposalId: string): Promise<ProposalRecord> {
    if (typeof proposalId !== "string" || proposalId.length === 0 || proposalId.length > 128) return fail("calendar_proposal_not_found");
    const record = await this.#database.read((db) => this.#repository.getProposal(db, actorId, proposalId));
    return record ?? fail("calendar_proposal_not_found");
  }

  #view(record: ProposalRecord): CalendarChangeProposal {
    return proposalView(record, this.#keyring);
  }

  /** pending -> expired at the injected clock, with one content-free audit row. */
  async #expireIfDue(record: ProposalRecord, requestId: string): Promise<ProposalRecord> {
    if (record.status !== "pending" || Date.parse(record.expiresAt) > this.#clock().getTime()) return record;
    return this.#database.transaction((db) => {
      const current = this.#repository.getProposal(db, record.actorId, record.id);
      if (current === null || current.status !== "pending") return current ?? record;
      const detached = current.eventRef === undefined && current.retainedEventRef !== undefined;
      const expired = this.#repository.transitionProposal(db, {
        actorId: current.actorId, proposalId: current.id, expectedVersion: current.version, from: ["pending"], to: "expired",
        completedAt: current.expiresAt, safeReasonCode: "proposal_expired",
        ...(detached ? { eventRef: current.retainedEventRef } : {}),
      });
      this.#repository.appendAudit(db, {
        id: randomUUID(), actorId: current.actorId, proposalId: current.id, operation: current.operation, outcome: "expired",
        requestId, occurredAt: this.#clock().toISOString(),
      });
      return expired;
    });
  }

  /** Resolves opaque references, checks write authorization and ownership, and builds the summary. */
  async #build(actorId: string, body: CreateCalendarChangeProposalBody, token: AuthorizedAccessToken): Promise<Built> {
    let target: Readonly<{ calendar: OpenedCalendar; providerEventId?: string; eventRef?: string }>;
    if (body.operation === "create") {
      const record = await this.#database.read((db) => this.#repository.resolveCalendar(db, actorId, body.calendarRef));
      if (record === null) return fail("calendar_not_found");
      target = { calendar: this.#reader.openCalendar(record) };
    } else {
      const resolved = await this.#reader.resolveReadable(actorId, body.eventRef);
      target = { calendar: resolved.calendar, providerEventId: resolved.providerEventId, eventRef: body.eventRef };
    }
    const calendar = target.calendar;
    if (!calendar.record.writeEnabled) return fail("calendar_not_writable");
    const providerCalendar = (await this.#provider(actorId, token, () => this.#google.listCalendars(token.accessToken)))
      .find((item) => item.id === calendar.providerCalendarId);
    if (providerCalendar === undefined || !canWrite(providerCalendar.accessRole)) return fail("calendar_not_writable");
    const calendarTimeZone = validTimeZone(providerCalendar.timeZone) ? providerCalendar.timeZone : "UTC";
    const calendarDisplayName = sanitizeExternalText(calendar.displayName, 200) || "Unnamed calendar";
    const sendUpdates = sendUpdatesFor(body.guestNotification);

    if (body.operation === "create") {
      const summary: CalendarChangeSummary = {
        operation: "create", calendarDisplayName,
        timeZone: body.draft.time.kind === "timed" ? body.draft.time.timeZone : calendarTimeZone,
        recurrenceScope: "single", organizerRelationship: "self", guestNotification: body.guestNotification,
        after: toEventPreview({ ...body.draft, attendees: body.draft.attendees.map(() => ({ responseStatus: "needs_action" as const })) }),
      };
      return {
        calendar: calendar.record,
        payload: { v: 1, summary, calendarRef: calendar.record.calendarRef, sendUpdates, event: writableFromDraft(body.draft) },
      };
    }

    const referenced = await this.#event(actorId, token, calendar, target.providerEventId!);
    let event = referenced;
    if (body.recurrenceScope === "series") {
      // The series target is derived from the provider's own recurringEventId, never from client input.
      if (referenced.recurringEventId === undefined) return fail("calendar_recurrence_scope_invalid");
      event = await this.#event(actorId, token, calendar, referenced.recurringEventId);
    }
    const detail = this.#detail(event, target.eventRef!, calendar, calendarTimeZone);
    const organizedBySelf = event.organizer?.self === true;
    const ownAttendee = event.attendees?.find((attendee) => attendee.self === true && attendee.email !== undefined);
    if (body.operation === "update" && !organizedBySelf) return fail("update_not_permitted");
    if (body.operation === "cancel" && !organizedBySelf) return fail("cancel_not_permitted");
    if (body.operation === "respond_invitation" && (organizedBySelf || ownAttendee === undefined)) {
      return fail("invitation_response_not_permitted");
    }
    const before = toEventPreview(detail);
    const timeZone = validTimeZone(event.start.timeZone) ? event.start.timeZone : calendarTimeZone;
    const common = {
      calendarDisplayName, timeZone, recurrenceScope: body.recurrenceScope,
      organizerRelationship: organizedBySelf ? "self" as const : "other" as const,
      guestNotification: body.guestNotification, before,
    };
    const base = { v: 1 as const, calendarRef: calendar.record.calendarRef, sendUpdates, targetProviderEventId: event.id };
    if (body.operation === "update") {
      const changes = body.changes;
      const location = changes.location ?? before.location;
      const after = {
        title: changes.title ?? before.title,
        time: changes.time ?? before.time,
        ...(location === undefined ? {} : { location }),
        attendeeCount: changes.attendees?.length ?? before.attendeeCount,
      };
      const writable: GoogleWritableEvent = {
        summary: changes.title ?? event.summary ?? detail.title,
        ...(changes.time === undefined ? { start: event.start, end: event.end } : googleTimes(changes.time)),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.location === undefined ? {} : { location: changes.location }),
        ...(changes.attendees === undefined ? {} : { attendees: changes.attendees.map((attendee) => ({ email: attendee.email })) }),
      };
      return {
        calendar: calendar.record, eventRef: target.eventRef!, etag: event.etag,
        payload: { ...base, summary: { operation: "update", ...common, after }, event: writable },
      };
    }
    if (body.operation === "cancel") {
      return { calendar: calendar.record, eventRef: target.eventRef!, etag: event.etag, payload: { ...base, summary: { operation: "cancel", ...common } } };
    }
    return {
      calendar: calendar.record, eventRef: target.eventRef!, etag: event.etag,
      payload: {
        ...base, response: body.response, attendeeEmail: ownAttendee!.email!,
        summary: { operation: "respond_invitation", ...common, invitationResponse: body.response },
      },
    };
  }

  #detail(event: GoogleEventRecord, eventRef: string, calendar: OpenedCalendar, timeZone: string): CalendarEventDetail {
    const detail = mapGoogleEvent(event, {
      eventRef, calendarRef: calendar.record.calendarRef, calendarDisplayName: calendar.displayName, timeZone,
    });
    return detail ?? fail("calendar_event_not_found");
  }

  async #event(actorId: string, token: AuthorizedAccessToken, calendar: OpenedCalendar, eventId: string): Promise<GoogleEventRecord> {
    try {
      const event = await this.#google.getEvent(token.accessToken, calendar.providerCalendarId, eventId);
      return event.status === "cancelled" ? fail("calendar_event_not_found") : event;
    } catch (error) {
      if (error instanceof Error && (error.message === "google_calendar_not_found" || error.message === "calendar_event_not_found")) {
        return fail("calendar_event_not_found");
      }
      await this.#reader.health.recordFailure(actorId, token.authorizationId, error);
      throw publicProviderError(error);
    }
  }

  async #provider<T>(actorId: string, token: AuthorizedAccessToken, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      await this.#reader.health.recordFailure(actorId, token.authorizationId, error);
      throw publicProviderError(error);
    }
  }
}

export type CalendarChangeServicesOptions = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  reader: CalendarEventReader;
  google: GoogleCalendarPort;
  keyring: CalendarKeyring;
  clock: () => Date;
  idGenerator: () => string;
  proposalTtlSeconds?: number;
}>;

/** Wires the proposal service, executor and reconciler around one shared per-proposal lock. */
export const createCalendarChangeServices = (options: CalendarChangeServicesOptions) => {
  const locks = new KeyedMutex();
  const executor = new CalendarChangeExecutor(options);
  const reconciler = new CalendarExecutionReconciler({ ...options, executor, locks });
  const proposals = new CalendarChangeProposalServiceImpl({ ...options, executor, reconciler, locks });
  return { proposals, executor, reconciler, locks };
};
