import { createHmac, randomUUID } from "node:crypto";

import {
  CalendarSelectionSchema,
  CalendarSourceStatusSchema,
  UpdateCalendarSelectionBodySchema,
  type CalendarSelection,
  type CalendarSelectionEntry,
  type CalendarSourceStatus,
  type DelegatedPrincipal,
  type UpdateCalendarSelectionBody,
} from "@personal-intelligence-hub/contracts";
import type { ConnectorDatabase } from "../../foundation/database.js";
import { calendarBlindIndex, openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import type { GoogleCalendarPort, GoogleCalendarRecord } from "../ports/google-calendar.js";
import {
  GOOGLE_CALENDAR_REQUIRED_SCOPES,
  type AuthorizedAccessToken,
  type GoogleAccessTokenProvider,
} from "./google-access-token-provider.js";
import type { CalendarRepository } from "../storage/calendar-repository.js";
import type { CalendarConnectionRecord, CalendarRecord } from "../storage/records.js";

export interface CalendarSelectionService {
  discover(principal: DelegatedPrincipal): Promise<CalendarSelection>;
  get(principal: DelegatedPrincipal): Promise<CalendarSelection>;
  update(principal: DelegatedPrincipal, body: UpdateCalendarSelectionBody): Promise<CalendarSelection>;
  bootstrapPrimary(input: BootstrapPrimaryInput): Promise<CalendarSourceStatus>;
}

type BootstrapPrimaryInput = Readonly<{ actorId: string; accessToken: string; authorizationId: string; requestId: string }>;

type Clock = () => Date;
type Options = Readonly<{
  database: ConnectorDatabase;
  repository: CalendarRepository;
  tokens: GoogleAccessTokenProvider;
  google: GoogleCalendarPort;
  keyring: CalendarKeyring;
  clock: Clock;
}>;
const fail = (code: string): never => { throw new Error(code); };
const providerSafeCodes = new Set([
  "google_calendar_reauthorization_required",
  "google_calendar_permission_denied",
  "google_calendar_temporarily_unavailable",
  "google_calendar_not_found",
  "google_calendar_conflict",
  "google_calendar_request_failed",
  "google_calendar_response_invalid",
  "calendar_reauthorization_required",
  "calendar_provider_temporarily_unavailable",
  "calendar_not_configured",
]);
const calendarAad = (actorId: string, field: "provider-id" | "display-name") =>
  `calendar_allowlist:${actorId}:${field}`;
const primaryAad = (actorId: string) => `calendar_connections:${actorId}:primary-calendar`;
const refFor = (actorId: string, providerCalendarId: string, key: Uint8Array): string =>
  "cal_" + createHmac("sha256", key).update(actorId + "\0" + providerCalendarId, "utf8").digest("base64url");
const canWrite = (role: GoogleCalendarRecord["accessRole"] | CalendarRecord["providerAccessRole"]): boolean => role === "writer" || role === "owner";
const sameConnectionSnapshot = (left: CalendarConnectionRecord, right: CalendarConnectionRecord): boolean =>
  left.actorId === right.actorId &&
  left.authorizationId === right.authorizationId &&
  left.state === right.state &&
  left.refreshTokenCiphertext === right.refreshTokenCiphertext &&
  (left.primaryCalendarBindingCiphertext ?? null) === (right.primaryCalendarBindingCiphertext ?? null) &&
  JSON.stringify(left.grantedScopes) === JSON.stringify(right.grantedScopes) &&
  left.selectionVersion === right.selectionVersion &&
  (left.lastSuccessAt ?? null) === (right.lastSuccessAt ?? null) &&
  (left.safeReasonCode ?? null) === (right.safeReasonCode ?? null) &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt;
const safeProviderError = (error: unknown): string =>
  error instanceof Error && providerSafeCodes.has(error.message) ? error.message : "google_calendar_temporarily_unavailable";
const accessRole = (role: GoogleCalendarRecord["accessRole"]): CalendarRecord["providerAccessRole"] => ({
  freeBusyReader: "free_busy_reader",
  reader: "reader",
  writer: "writer",
  owner: "owner",
})[role] as CalendarRecord["providerAccessRole"];
const requirePrincipal = (principal: DelegatedPrincipal, scope: "calendar:read" | "calendar:configure"): void => {
  if (!principal.scopes.includes(scope)) fail("forbidden");
  if (scope === "calendar:configure" && (principal.serviceId !== "pih-web" || principal.actorType !== "human")) {
    fail("forbidden");
  }
};
const openRecord = (record: CalendarRecord, keyring: CalendarKeyring): CalendarSelectionEntry => {
  const displayName = openCalendarValue(record.displayNameCiphertext, calendarAad(record.actorId, "display-name"), keyring);
  return {
    calendarRef: record.calendarRef,
    displayName,
    accessRole: record.providerAccessRole,
    readEnabled: record.readEnabled,
    writeEnabled: record.writeEnabled && (record.providerAccessRole === "writer" || record.providerAccessRole === "owner"),
    isPrimary: record.isPrimary,
  };
};
const connectionStatus = (
  connection: CalendarConnectionRecord | null,
  calendars: readonly CalendarRecord[],
  now: string,
): CalendarSourceStatus => {
  if (connection === null) {
    return CalendarSourceStatusSchema.parse({
      state: "not_configured", checkedAt: now, stale: false, canRead: false,
      canProposeChanges: false, primaryCalendarConfigured: false, additionalCalendarCount: 0,
    });
  }
  const primaryCalendarConfigured = connection.primaryCalendarBindingCiphertext !== undefined &&
    calendars.some((calendar) => calendar.isPrimary && calendar.readEnabled);
  const hasRead = calendars.some((calendar) => calendar.readEnabled);
  const hasRequiredScopes = GOOGLE_CALENDAR_REQUIRED_SCOPES.every((scope) => connection.grantedScopes.includes(scope));
  const canReadCalendars = connection.state !== "requires_reauthorization" && hasRequiredScopes && hasRead;
  const canWriteCalendars = canReadCalendars && calendars.some((calendar) =>
    calendar.writeEnabled && canWrite(calendar.providerAccessRole),
  );
  const common = {
    checkedAt: now,
    ...(connection.lastSuccessAt === undefined ? {} : { lastSuccessAt: connection.lastSuccessAt }),
    stale: false,
    canRead: canReadCalendars,
    canProposeChanges: canWriteCalendars,
    primaryCalendarConfigured,
    additionalCalendarCount: calendars.filter((calendar) => !calendar.isPrimary).length,
  };
  if (!hasRequiredScopes || connection.state === "requires_reauthorization" || connection.safeReasonCode === "reauthorization_required") {
    return CalendarSourceStatusSchema.parse({ ...common, state: "requires_reauthorization", safeReasonCode: "reauthorization_required" });
  }
  if (!primaryCalendarConfigured) {
    return CalendarSourceStatusSchema.parse({ ...common, state: "requires_attention", safeReasonCode: "calendar_selection_required" });
  }
  if (connection.state === "degraded" || connection.safeReasonCode === "provider_temporarily_unavailable" ||
      connection.safeReasonCode === "provider_permission_denied") {
    const safeReasonCode = connection.safeReasonCode === "provider_permission_denied"
      ? "provider_permission_denied" : "provider_temporarily_unavailable";
    return CalendarSourceStatusSchema.parse({ ...common, state: connection.lastSuccessAt === undefined ? "unavailable" : "degraded", stale: connection.lastSuccessAt !== undefined, safeReasonCode });
  }
  return CalendarSourceStatusSchema.parse({ ...common, state: "available" });
};

export class CalendarSelectionServiceImpl implements CalendarSelectionService {
  readonly #database: ConnectorDatabase;
  readonly #repository: CalendarRepository;
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #google: GoogleCalendarPort;
  readonly #keyring: CalendarKeyring;
  readonly #clock: Clock;
  readonly #actorLocks = new Map<string, Promise<void>>();

  constructor(options: Options) {
    this.#database = options.database;
    this.#repository = options.repository;
    this.#tokens = options.tokens;
    this.#google = options.google;
    this.#keyring = options.keyring;
    this.#clock = options.clock;
  }

  async discover(principal: DelegatedPrincipal): Promise<CalendarSelection> {
    requirePrincipal(principal, "calendar:read");
    return this.#exclusive(principal.actorId, async () => {
      const token = await this.#token(principal.actorId);
      let providerCalendars: readonly GoogleCalendarRecord[];
      try {
        providerCalendars = await this.#google.listCalendars(token.accessToken);
      } catch (error) {
        await this.#recordProviderFailure(principal.actorId, token.authorizationId, error);
        throw this.#publicProviderError(error);
      }
      await this.#recordSuccess(principal.actorId, token.authorizationId);
      const saved = await this.#database.read((db) => this.#repository.listCalendars(db, principal.actorId));
      const savedByRef = new Map(saved.map((record) => [record.calendarRef, record]));
      const items = providerCalendars.map((providerCalendar) => {
        const ref = this.#calendarRef(principal.actorId, providerCalendar.id);
        const previous = savedByRef.get(ref);
        return previous === undefined
          ? {
              calendarRef: ref,
              displayName: providerCalendar.summary,
              accessRole: accessRole(providerCalendar.accessRole),
              readEnabled: false,
              writeEnabled: false,
              isPrimary: providerCalendar.primary,
            }
          : {
              ...openRecord(previous, this.#keyring),
              displayName: providerCalendar.summary,
              accessRole: accessRole(providerCalendar.accessRole),
              writeEnabled: previous.writeEnabled && canWrite(providerCalendar.accessRole),
              isPrimary: providerCalendar.primary,
            };
      });
      return CalendarSelectionSchema.parse({
        version: await this.#database.read((db) => this.#repository.getConnection(db, principal.actorId)?.selectionVersion ?? 0),
        items,
      });
    });
  }

  async get(principal: DelegatedPrincipal): Promise<CalendarSelection> {
    requirePrincipal(principal, "calendar:read");
    const result = await this.#database.read((db) => ({
      version: this.#repository.getConnection(db, principal.actorId)?.selectionVersion ?? 0,
      calendars: this.#repository.listCalendars(db, principal.actorId),
    }));
    return CalendarSelectionSchema.parse({
      version: result.version,
      items: result.calendars.map((record) => openRecord(record, this.#keyring)),
    });
  }

  async update(principal: DelegatedPrincipal, body: UpdateCalendarSelectionBody): Promise<CalendarSelection> {
    requirePrincipal(principal, "calendar:configure");
    const parsedBody = UpdateCalendarSelectionBodySchema.safeParse(body);
    if (!parsedBody.success) return fail("calendar_selection_invalid");
    return this.#exclusive(principal.actorId, async () => {
      const authorizationBeforeToken = await this.#database.read((db) => this.#repository.getConnection(db, principal.actorId));
      if (authorizationBeforeToken === null) return fail("calendar_not_configured");
      const token = await this.#token(principal.actorId);
      const connectionSnapshot = await this.#database.read((db) => this.#repository.getConnection(db, principal.actorId));
      if (connectionSnapshot === null) return fail("calendar_not_configured");
      if (token.authorizationId !== authorizationBeforeToken.authorizationId ||
          token.authorizationId !== connectionSnapshot.authorizationId) {
        return fail("calendar_connection_changed");
      }
      let providerCalendars: readonly GoogleCalendarRecord[];
      try {
        providerCalendars = await this.#google.listCalendars(token.accessToken);
      } catch (error) {
        await this.#recordProviderFailure(principal.actorId, token.authorizationId, error);
        throw this.#publicProviderError(error);
      }
      const discovered = new Map(providerCalendars.map((item) => [this.#calendarRef(principal.actorId, item.id), item]));
      const timestamp = this.#clock().toISOString();
      const records: CalendarRecord[] = [];
      const seen = new Set<string>();
      for (const request of parsedBody.data.calendars) {
        if (seen.has(request.calendarRef)) return fail("calendar_selection_invalid");
        seen.add(request.calendarRef);
        const provider = discovered.get(request.calendarRef);
        if (provider === undefined) return fail("calendar_not_found");
        const writable = canWrite(provider.accessRole);
        records.push({
          actorId: principal.actorId,
          calendarRef: request.calendarRef,
          providerCalendarIdCiphertext: sealCalendarValue(provider.id, calendarAad(principal.actorId, "provider-id"), this.#keyring),
          providerCalendarBlindIndex: calendarBlindIndex(provider.id, this.#keyring),
          displayNameCiphertext: sealCalendarValue(provider.summary, calendarAad(principal.actorId, "display-name"), this.#keyring),
          providerAccessRole: accessRole(provider.accessRole),
          readEnabled: request.readEnabled,
          writeEnabled: request.writeEnabled && writable,
          isPrimary: provider.primary,
          lastVerifiedAt: timestamp,
        });
      }
      if (records.filter((item) => item.isPrimary && (item.readEnabled || item.writeEnabled)).length !== 1) {
        return fail("calendar_selection_primary_required");
      }
      try {
        const version = await this.#database.transaction((db) => {
          const current = this.#repository.getConnection(db, principal.actorId);
          if (current === null) return fail("calendar_not_configured");
          if (!sameConnectionSnapshot(current, connectionSnapshot)) return fail("calendar_connection_changed");
          const nextVersion = this.#repository.replaceCalendarSelection(
            db, principal.actorId, parsedBody.data.expectedVersion, records, token.authorizationId,
          );
          this.#repository.appendAudit(db, {
            id: randomUUID(), actorId: principal.actorId, operation: "selection_change", outcome: "selection_updated",
            requestId: principal.requestId, occurredAt: timestamp,
          });
          return nextVersion;
        });
        await this.#recordSuccess(principal.actorId, token.authorizationId);
        return CalendarSelectionSchema.parse({
          version,
          items: records.filter((record) => record.readEnabled || record.writeEnabled).map((record) => openRecord(record, this.#keyring)),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "calendar_selection_version_conflict") throw error;
        if (error instanceof Error && error.message === "calendar_connection_changed") throw error;
        if (error instanceof Error && error.message === "calendar_selection_primary_required") throw error;
        if (error instanceof Error && error.message === "calendar_selection_actor_mismatch") throw error;
        throw new Error("calendar_selection_update_failed");
      }
    });
  }

  async bootstrapPrimary(input: BootstrapPrimaryInput): Promise<CalendarSourceStatus> {
    return this.#exclusive(input.actorId, async () => {
      const existing = await this.#database.read((db) => this.#repository.getConnection(db, input.actorId));
      if (existing === null) return fail("calendar_not_configured");
      if (existing.authorizationId !== input.authorizationId) return fail("calendar_connection_changed");
      if (existing.primaryCalendarBindingCiphertext !== undefined && existing.selectionVersion >= 1) {
        return this.#status(input.actorId);
      }
      if (existing.state === "requires_reauthorization" ||
          !GOOGLE_CALENDAR_REQUIRED_SCOPES.every((scope) => existing.grantedScopes.includes(scope))) {
        const error = new Error("calendar_reauthorization_required");
        await this.#recordProviderFailure(input.actorId, input.authorizationId, error);
        throw this.#publicProviderError(error);
      }

      let providerCalendars: readonly GoogleCalendarRecord[];
      try {
        providerCalendars = await this.#google.listCalendars(input.accessToken);
      } catch (error) {
        await this.#recordProviderFailure(input.actorId, input.authorizationId, error);
        throw this.#publicProviderError(error);
      }
      const primaries = providerCalendars.filter((calendar) => calendar.primary);
      if (primaries.length !== 1 || !canWrite(primaries[0]!.accessRole)) {
        await this.#recordSuccess(input.actorId, input.authorizationId);
        return fail("calendar_primary_unavailable");
      }
      const primary = primaries[0]!;
      const timestamp = this.#clock().toISOString();
      try {
        await this.#database.transaction((db) => {
          const connection = this.#repository.getConnection(db, input.actorId);
          if (connection === null) return fail("calendar_not_configured");
          if (connection.authorizationId !== input.authorizationId) return fail("calendar_connection_changed");
          if (connection.primaryCalendarBindingCiphertext !== undefined && connection.selectionVersion >= 1) return;
          if (connection.refreshTokenCiphertext !== existing.refreshTokenCiphertext ||
              connection.updatedAt !== existing.updatedAt ||
              connection.selectionVersion !== existing.selectionVersion ||
              connection.grantedScopes.join(" ") !== existing.grantedScopes.join(" ")) {
            return fail("calendar_connection_changed");
          }
          const record: CalendarRecord = {
            actorId: input.actorId,
            calendarRef: this.#calendarRef(input.actorId, primary.id),
            providerCalendarIdCiphertext: sealCalendarValue(primary.id, calendarAad(input.actorId, "provider-id"), this.#keyring),
            providerCalendarBlindIndex: calendarBlindIndex(primary.id, this.#keyring),
            displayNameCiphertext: sealCalendarValue(primary.summary, calendarAad(input.actorId, "display-name"), this.#keyring),
            providerAccessRole: accessRole(primary.accessRole),
            readEnabled: true, writeEnabled: true, isPrimary: true, lastVerifiedAt: timestamp,
          };
          const initialVersion = connection.selectionVersion;
          this.#repository.replaceCalendarSelection(db, input.actorId, initialVersion, [record], input.authorizationId);
          const current = this.#repository.getConnection(db, input.actorId)!;
          const { safeReasonCode: _safeReasonCode, ...fields } = current;
          const bound = this.#repository.saveConnectionIfUnchanged(db, current, {
            ...fields,
            state: "available",
            primaryCalendarBindingCiphertext: sealCalendarValue(primary.id, primaryAad(input.actorId), this.#keyring),
            selectionVersion: initialVersion === 1 ? 1 : initialVersion + 1,
            lastSuccessAt: timestamp,
            updatedAt: timestamp,
          });
          if (!bound) fail("calendar_connection_changed");
          this.#repository.appendAudit(db, {
            id: randomUUID(), actorId: input.actorId, operation: "selection_change", outcome: "selection_updated",
            requestId: input.requestId, occurredAt: timestamp,
          });
        });
      } catch (error) {
        if (error instanceof Error && (error.message === "calendar_not_configured" || error.message === "calendar_connection_changed")) throw error;
        throw new Error("calendar_primary_bootstrap_failed");
      }
      return this.#status(input.actorId);
    });
  }

  async #token(actorId: string): Promise<AuthorizedAccessToken> {
    const before = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    try {
      return await this.#tokens.getAuthorizedAccessToken(actorId);
    } catch (error) {
      if (before !== null) await this.#recordProviderFailure(actorId, before.authorizationId, error);
      throw this.#publicProviderError(error);
    }
  }

  #calendarRef(actorId: string, providerCalendarId: string): string {
    return refFor(actorId, providerCalendarId, this.#keyring.blindIndexKey);
  }

  async #recordSuccess(actorId: string, authorizationId: string): Promise<void> {
    const existing = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (existing === null || existing.authorizationId !== authorizationId || existing.state === "requires_reauthorization") return;
    const { safeReasonCode: reason, ...fields } = existing;
    const replacement: CalendarConnectionRecord = {
      ...fields, state: "available", lastSuccessAt: this.#clock().toISOString(), updatedAt: this.#clock().toISOString(),
      ...(reason === "reauthorization_required" ? { safeReasonCode: reason } : {}),
    };
    await this.#database.write((db) => { this.#repository.saveConnectionIfUnchanged(db, existing, replacement); });
  }

  async #recordProviderFailure(actorId: string, authorizationId: string, error: unknown): Promise<void> {
    const code = safeProviderError(error);
    const reauth = code === "google_calendar_reauthorization_required" || code === "calendar_reauthorization_required";
    const permissionDenied = code === "google_calendar_permission_denied";
    if (!reauth && !permissionDenied && code !== "google_calendar_temporarily_unavailable" &&
        code !== "calendar_provider_temporarily_unavailable") return;
    const existing = await this.#database.read((db) => this.#repository.getConnection(db, actorId));
    if (existing === null || existing.authorizationId !== authorizationId || existing.state === "requires_reauthorization") return;
    const timestamp = this.#clock().toISOString();
    const safeReasonCode = reauth ? "reauthorization_required" :
      permissionDenied ? "provider_permission_denied" : "provider_temporarily_unavailable";
    const replacement: CalendarConnectionRecord = {
      ...existing,
      state: reauth ? "requires_reauthorization" : "degraded",
      safeReasonCode,
      updatedAt: timestamp,
    };
    await this.#database.write((db) => { this.#repository.saveConnectionIfUnchanged(db, existing, replacement); });
  }

  #publicProviderError(error: unknown): Error {
    const code = safeProviderError(error);
    if (code === "calendar_not_configured") return new Error(code);
    if (code === "google_calendar_reauthorization_required" || code === "calendar_reauthorization_required") {
      return new Error("calendar_reauthorization_required");
    }
    if (code === "google_calendar_permission_denied") return new Error("calendar_provider_permission_denied");
    if (code === "google_calendar_not_found") return new Error("calendar_not_found");
    if (code === "google_calendar_conflict") return new Error("calendar_provider_conflict");
    if (code === "google_calendar_temporarily_unavailable" || code === "calendar_provider_temporarily_unavailable") {
      return new Error("calendar_provider_temporarily_unavailable");
    }
    return new Error("calendar_provider_request_failed");
  }

  async #status(actorId: string): Promise<CalendarSourceStatus> {
    const result = await this.#database.read((db) => ({
      connection: this.#repository.getConnection(db, actorId),
      calendars: this.#repository.listCalendars(db, actorId),
    }));
    return connectionStatus(result.connection, result.calendars, this.#clock().toISOString());
  }

  async #exclusive<T>(actorId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#actorLocks.get(actorId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.#actorLocks.set(actorId, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#actorLocks.get(actorId) === next) this.#actorLocks.delete(actorId);
    }
  }
}

