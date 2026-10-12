import type { CalendarProposalStatus } from "@personal-intelligence-hub/contracts";
import type { SqliteHandle } from "../../foundation/database.js";
import type {
  CalendarConnectionRecord,
  CalendarRecord,
  EventReferenceRecord,
  NewOAuthTransaction,
  OAuthTransaction,
  ProposalInsertResult,
  ProposalRecord,
  ProposalTransition,
  SanitizedCalendarAuditRecord,
} from "./records.js";

type ConnectionRow = Readonly<{
  actor_id: string;
  state: CalendarConnectionRecord["state"];
  refresh_token_ciphertext: string;
  primary_calendar_binding_ciphertext: string | null;
  granted_scopes_json: string;
  selection_version: number;
  last_success_at: string | null;
  safe_reason_code: CalendarConnectionRecord["safeReasonCode"] | null;
  created_at: string;
  updated_at: string;
}>;
type CalendarRow = Readonly<{
  actor_id: string; calendar_ref: string; provider_calendar_id_ciphertext: string;
  provider_calendar_blind_index: string; display_name_ciphertext: string;
  provider_access_role: CalendarRecord["providerAccessRole"]; read_enabled: number;
  write_enabled: number; is_primary: number; last_verified_at: string;
}>;
type EventRow = Readonly<{
  actor_id: string; event_ref: string; calendar_ref: string;
  provider_event_id_ciphertext: string; provider_event_blind_index: string;
  last_observed_at: string;
}>;
type ProposalRow = Readonly<{
  actor_id: string; id: string; version: number; status: CalendarProposalStatus;
  operation: ProposalRecord["operation"]; event_ref: string | null;
  encrypted_payload: string | null; payload_purged_at: string | null;
  provider_etag_ciphertext: string | null; created_by_actor_type: ProposalRecord["createdByActorType"];
  created_at: string; expires_at: string; completed_at: string | null;
  safe_reason_code: ProposalRecord["safeReasonCode"] | null;
}>;
type OAuthRow = Readonly<{
  state_hash: string; actor_id: string; verifier_ciphertext: string; expires_at: string;
  consumed_at: string | null; authorization_completed_at: string | null;
}>;

const fail = (code: string): never => { throw new Error(code); };
const requireChanges = (changes: number, code = "calendar_repository_conflict"): void => {
  if (changes !== 1) fail(code);
};
const optional = <T extends object, K extends string, V>(
  target: T, key: K, value: V | null | undefined,
): T & Partial<Record<K, V>> => {
  if (value !== null && value !== undefined) Object.assign(target, { [key]: value });
  return target as T & Partial<Record<K, V>>;
};

const mapConnection = (row: ConnectionRow | undefined): CalendarConnectionRecord | null => row === undefined ? null : ({
  actorId: row.actor_id, state: row.state, refreshTokenCiphertext: row.refresh_token_ciphertext,
  grantedScopes: JSON.parse(row.granted_scopes_json) as string[], selectionVersion: row.selection_version,
  createdAt: row.created_at, updatedAt: row.updated_at,
  ...optional({}, "primaryCalendarBindingCiphertext", row.primary_calendar_binding_ciphertext),
  ...optional({}, "lastSuccessAt", row.last_success_at),
  ...optional({}, "safeReasonCode", row.safe_reason_code),
});
const mapOAuth = (row: OAuthRow | undefined): OAuthTransaction | null => row === undefined ? null : ({
  stateHash: row.state_hash, actorId: row.actor_id, verifierCiphertext: row.verifier_ciphertext,
  expiresAt: row.expires_at,
  ...optional({}, "consumedAt", row.consumed_at),
  ...optional({}, "authorizationCompletedAt", row.authorization_completed_at),
});
const mapCalendar = (row: CalendarRow): CalendarRecord => ({
  actorId: row.actor_id, calendarRef: row.calendar_ref,
  providerCalendarIdCiphertext: row.provider_calendar_id_ciphertext,
  providerCalendarBlindIndex: row.provider_calendar_blind_index,
  displayNameCiphertext: row.display_name_ciphertext, providerAccessRole: row.provider_access_role,
  readEnabled: row.read_enabled === 1, writeEnabled: row.write_enabled === 1,
  isPrimary: row.is_primary === 1, lastVerifiedAt: row.last_verified_at,
});
const mapEvent = (row: EventRow): EventReferenceRecord => ({
  actorId: row.actor_id, eventRef: row.event_ref, calendarRef: row.calendar_ref,
  providerEventIdCiphertext: row.provider_event_id_ciphertext,
  providerEventBlindIndex: row.provider_event_blind_index, lastObservedAt: row.last_observed_at,
});
const mapProposal = (row: ProposalRow | undefined): ProposalRecord | null => row === undefined ? null : ({
  actorId: row.actor_id, id: row.id, version: row.version, status: row.status,
  operation: row.operation, createdByActorType: row.created_by_actor_type,
  createdAt: row.created_at, expiresAt: row.expires_at,
  ...optional({}, "eventRef", row.event_ref),
  ...optional({}, "encryptedPayload", row.encrypted_payload),
  ...optional({}, "payloadPurgedAt", row.payload_purged_at),
  ...optional({}, "providerEtagCiphertext", row.provider_etag_ciphertext),
  ...optional({}, "completedAt", row.completed_at),
  ...optional({}, "safeReasonCode", row.safe_reason_code),
});

const requireOwnedEventReference = (database: SqliteHandle, actorId: string, eventRef: string | undefined): void => {
  if (eventRef === undefined) return;
  const row = database.prepare("SELECT 1 AS found FROM calendar_event_refs WHERE actor_id = :actorId AND event_ref = :eventRef")
    .get<{ found: number }>({ actorId, eventRef });
  if (row === undefined) fail("calendar_event_reference_not_found");
};

const selectConnection = (database: SqliteHandle, actorId: string) =>
  database.prepare("SELECT * FROM calendar_connections WHERE actor_id = :actorId").get<ConnectionRow>({ actorId });
const selectProposal = (database: SqliteHandle, actorId: string, proposalId: string) =>
  database.prepare("SELECT * FROM calendar_change_proposals WHERE actor_id = :actorId AND id = :proposalId")
    .get<ProposalRow>({ actorId, proposalId });

export interface CalendarRepository {
  createOAuthTransaction(database: SqliteHandle, input: NewOAuthTransaction): void;
  consumeOAuthTransaction(database: SqliteHandle, stateHash: string, actorId: string, now: string): OAuthTransaction | null;
  getOAuthTransactionReplay(database: SqliteHandle, stateHash: string, actorId: string, now: string): OAuthTransaction | null;
  markOAuthAuthorizationCompleted(database: SqliteHandle, stateHash: string, completedAt: string): void;
  getConnection(database: SqliteHandle, actorId: string): CalendarConnectionRecord | null;
  saveConnection(database: SqliteHandle, connection: CalendarConnectionRecord): void;
  replaceConnectionAuthorization(database: SqliteHandle, connection: CalendarConnectionRecord): void;
  deleteConnection(database: SqliteHandle, actorId: string): void;
  listCalendars(database: SqliteHandle, actorId: string): readonly CalendarRecord[];
  replaceCalendarSelection(database: SqliteHandle, actorId: string, expectedVersion: number, calendars: readonly CalendarRecord[]): number;
  resolveCalendar(database: SqliteHandle, actorId: string, calendarRef: string): CalendarRecord | null;
  resolveEvent(database: SqliteHandle, actorId: string, eventRef: string): EventReferenceRecord | null;
  upsertEventReference(database: SqliteHandle, record: EventReferenceRecord): void;
  insertProposal(database: SqliteHandle, proposal: ProposalRecord, idempotencyKey: string, requestHash: string): ProposalInsertResult;
  getProposal(database: SqliteHandle, actorId: string, proposalId: string): ProposalRecord | null;
  listExecutingProposals(database: SqliteHandle, limit: number): readonly ProposalRecord[];
  transitionProposal(database: SqliteHandle, input: ProposalTransition): ProposalRecord;
  appendAudit(database: SqliteHandle, record: SanitizedCalendarAuditRecord): void;
  expirePendingProposals(database: SqliteHandle, now: string): number;
  purgeOAuthTransactions(database: SqliteHandle, olderThan: string): number;
  purgeStaleEventReferences(database: SqliteHandle, olderThan: string): number;
  purgeTerminalProposalPayloads(database: SqliteHandle, olderThan: string): number;
  purgeIdempotencyRecords(database: SqliteHandle, olderThan: string): number;
}

export const createCalendarRepository = (): CalendarRepository => ({
  createOAuthTransaction(database, input) {
    const result = database.prepare("INSERT INTO calendar_oauth_transactions(state_hash, actor_id, verifier_ciphertext, expires_at) VALUES(:stateHash, :actorId, :verifierCiphertext, :expiresAt)")
      .run({ stateHash: input.stateHash, actorId: input.actorId, verifierCiphertext: input.verifierCiphertext, expiresAt: input.expiresAt });
    requireChanges(result.changes);
  },
  consumeOAuthTransaction(database, stateHash, actorId, now) {
    const result = database.prepare("UPDATE calendar_oauth_transactions SET consumed_at = :now WHERE state_hash = :stateHash AND actor_id = :actorId AND consumed_at IS NULL AND expires_at > :now")
      .run({ stateHash, actorId, now });
    if (result.changes !== 1) return null;
    return mapOAuth(database.prepare("SELECT * FROM calendar_oauth_transactions WHERE state_hash = :stateHash AND actor_id = :actorId")
      .get<OAuthRow>({ stateHash, actorId }));
  },
  getOAuthTransactionReplay(database, stateHash, actorId, now) {
    return mapOAuth(database.prepare("SELECT * FROM calendar_oauth_transactions WHERE state_hash = :stateHash AND actor_id = :actorId AND consumed_at IS NOT NULL AND authorization_completed_at IS NOT NULL AND expires_at > :now")
      .get<OAuthRow>({ stateHash, actorId, now }));
  },
  markOAuthAuthorizationCompleted(database, stateHash, completedAt) {
    const result = database.prepare("UPDATE calendar_oauth_transactions SET authorization_completed_at = :completedAt WHERE state_hash = :stateHash AND consumed_at IS NOT NULL AND authorization_completed_at IS NULL")
      .run({ stateHash, completedAt });
    requireChanges(result.changes, "calendar_oauth_transaction_unavailable");
  },
  getConnection(database, actorId) {
    return mapConnection(selectConnection(database, actorId));
  },
  saveConnection(database, connection) {
    const result = database.prepare(
      "INSERT INTO calendar_connections(actor_id, state, refresh_token_ciphertext, primary_calendar_binding_ciphertext, granted_scopes_json, selection_version, last_success_at, safe_reason_code, created_at, updated_at) " +
      "VALUES(:actorId, :state, :refreshTokenCiphertext, :primaryCalendarBindingCiphertext, :grantedScopesJson, :selectionVersion, :lastSuccessAt, :safeReasonCode, :createdAt, :updatedAt) " +
      "ON CONFLICT(actor_id) DO UPDATE SET state = excluded.state, refresh_token_ciphertext = excluded.refresh_token_ciphertext, primary_calendar_binding_ciphertext = excluded.primary_calendar_binding_ciphertext, granted_scopes_json = excluded.granted_scopes_json, selection_version = excluded.selection_version, last_success_at = excluded.last_success_at, safe_reason_code = excluded.safe_reason_code, updated_at = excluded.updated_at",
    ).run({
      actorId: connection.actorId, state: connection.state, refreshTokenCiphertext: connection.refreshTokenCiphertext,
      primaryCalendarBindingCiphertext: connection.primaryCalendarBindingCiphertext ?? null,
      grantedScopesJson: JSON.stringify(connection.grantedScopes), selectionVersion: connection.selectionVersion,
      lastSuccessAt: connection.lastSuccessAt ?? null, safeReasonCode: connection.safeReasonCode ?? null,
      createdAt: connection.createdAt, updatedAt: connection.updatedAt,
    });
    requireChanges(result.changes);
  },
  replaceConnectionAuthorization(database, connection) {
    database.prepare("DELETE FROM calendar_idempotency WHERE actor_id = :actorId").run({ actorId: connection.actorId });
    database.prepare("DELETE FROM calendar_change_proposals WHERE actor_id = :actorId").run({ actorId: connection.actorId });
    database.prepare("DELETE FROM calendar_event_refs WHERE actor_id = :actorId").run({ actorId: connection.actorId });
    database.prepare("DELETE FROM calendar_allowlist WHERE actor_id = :actorId").run({ actorId: connection.actorId });
    const replacement = { ...connection };
    delete (replacement as { primaryCalendarBindingCiphertext?: string }).primaryCalendarBindingCiphertext;
    this.saveConnection(database, { ...replacement, selectionVersion: 1 });
  },
  deleteConnection(database, actorId) {
    const result = database.prepare("DELETE FROM calendar_connections WHERE actor_id = :actorId").run({ actorId });
    requireChanges(result.changes, "calendar_connection_not_found");
  },
  listCalendars(database, actorId) {
    return database.prepare("SELECT * FROM calendar_allowlist WHERE actor_id = :actorId ORDER BY calendar_ref")
      .all<CalendarRow>({ actorId }).map(mapCalendar);
  },
  replaceCalendarSelection(database, actorId, expectedVersion, calendars) {
    if (calendars.some((item) => item.actorId !== actorId)) {
      fail("calendar_selection_actor_mismatch");
    }
    const connectionRow = selectConnection(database, actorId);
    if (connectionRow === undefined || connectionRow.selection_version !== expectedVersion) fail("calendar_selection_version_conflict");
    const selected = calendars.filter((item) => item.readEnabled || item.writeEnabled);
    if (selected.length === 0 || selected.filter((item) => item.isPrimary).length !== 1 ||
        selected.some((item) => item.isPrimary && !item.readEnabled && !item.writeEnabled)) {
      fail("calendar_selection_primary_required");
    }
    const update = database.prepare("UPDATE calendar_connections SET selection_version = selection_version + 1 WHERE actor_id = :actorId AND selection_version = :expectedVersion")
      .run({ actorId, expectedVersion });
    requireChanges(update.changes, "calendar_selection_version_conflict");

    const selectedRefs = new Set(selected.map((item) => item.calendarRef));
    const existing = database.prepare("SELECT calendar_ref, provider_calendar_blind_index FROM calendar_allowlist WHERE actor_id = :actorId")
      .all<{ calendar_ref: string; provider_calendar_blind_index: string }>({ actorId });
    const removeCalendar = database.prepare("DELETE FROM calendar_allowlist WHERE actor_id = :actorId AND calendar_ref = :calendarRef");
    for (const row of existing) {
      if (!selectedRefs.has(row.calendar_ref)) {
        removeCalendar.run({ actorId, calendarRef: row.calendar_ref });
      }
    }

    const upsert = database.prepare(
      "INSERT INTO calendar_allowlist(actor_id, calendar_ref, provider_calendar_id_ciphertext, provider_calendar_blind_index, display_name_ciphertext, provider_access_role, read_enabled, write_enabled, is_primary, last_verified_at) " +
      "VALUES(:actorId, :calendarRef, :providerCalendarIdCiphertext, :providerCalendarBlindIndex, :displayNameCiphertext, :providerAccessRole, :readEnabled, :writeEnabled, :isPrimary, :lastVerifiedAt) " +
      "ON CONFLICT(actor_id, calendar_ref) DO UPDATE SET provider_calendar_id_ciphertext = excluded.provider_calendar_id_ciphertext, provider_calendar_blind_index = excluded.provider_calendar_blind_index, display_name_ciphertext = excluded.display_name_ciphertext, provider_access_role = excluded.provider_access_role, read_enabled = excluded.read_enabled, write_enabled = excluded.write_enabled, is_primary = excluded.is_primary, last_verified_at = excluded.last_verified_at",
    );
    for (const item of selected) {
      const previous = existing.find((row) => row.calendar_ref === item.calendarRef);
      if (previous !== undefined && previous.provider_calendar_blind_index !== item.providerCalendarBlindIndex) {
        removeCalendar.run({ actorId, calendarRef: item.calendarRef });
      }
      const result = upsert.run({
        actorId, calendarRef: item.calendarRef,
        providerCalendarIdCiphertext: item.providerCalendarIdCiphertext,
        providerCalendarBlindIndex: item.providerCalendarBlindIndex,
        displayNameCiphertext: item.displayNameCiphertext, providerAccessRole: item.providerAccessRole,
        readEnabled: Number(item.readEnabled), writeEnabled: Number(item.writeEnabled),
        isPrimary: Number(item.isPrimary), lastVerifiedAt: item.lastVerifiedAt,
      });
      requireChanges(result.changes);
    }
    return expectedVersion + 1;
  },
  resolveCalendar(database, actorId, calendarRef) {
    const row = database.prepare("SELECT * FROM calendar_allowlist WHERE actor_id = :actorId AND calendar_ref = :calendarRef")
      .get<CalendarRow>({ actorId, calendarRef });
    return row === undefined ? null : mapCalendar(row);
  },
  resolveEvent(database, actorId, eventRef) {
    const row = database.prepare("SELECT * FROM calendar_event_refs WHERE actor_id = :actorId AND event_ref = :eventRef")
      .get<EventRow>({ actorId, eventRef });
    return row === undefined ? null : mapEvent(row);
  },
  upsertEventReference(database, record) {
    const result = database.prepare(
      "INSERT INTO calendar_event_refs(actor_id, event_ref, calendar_ref, provider_event_id_ciphertext, provider_event_blind_index, last_observed_at) VALUES(:actorId, :eventRef, :calendarRef, :providerEventIdCiphertext, :providerEventBlindIndex, :lastObservedAt) " +
      "ON CONFLICT(actor_id, event_ref) DO UPDATE SET calendar_ref = excluded.calendar_ref, provider_event_id_ciphertext = excluded.provider_event_id_ciphertext, provider_event_blind_index = excluded.provider_event_blind_index, last_observed_at = excluded.last_observed_at",
    ).run(record);
    requireChanges(result.changes);
  },
  insertProposal(database, proposal, idempotencyKey, requestHash) {
    const previous = database.prepare("SELECT request_hash, proposal_id FROM calendar_idempotency WHERE actor_id = :actorId AND idempotency_key_hash = :idempotencyKey")
      .get<{ request_hash: string; proposal_id: string }>({ actorId: proposal.actorId, idempotencyKey });
    if (previous !== undefined) {
      if (previous.request_hash !== requestHash) return { kind: "conflict" };
      const existing = selectProposal(database, proposal.actorId, previous.proposal_id);
      return existing === undefined ? { kind: "conflict" } : { kind: "replayed", proposal: mapProposal(existing)! };
    }
    requireOwnedEventReference(database, proposal.actorId, proposal.eventRef);
    const inserted = database.prepare(
      "INSERT INTO calendar_change_proposals(actor_id, id, version, status, operation, event_ref, encrypted_payload, payload_purged_at, provider_etag_ciphertext, created_by_actor_type, created_at, expires_at, completed_at, safe_reason_code) " +
      "VALUES(:actorId, :id, :version, :status, :operation, :eventRef, :encryptedPayload, :payloadPurgedAt, :providerEtagCiphertext, :createdByActorType, :createdAt, :expiresAt, :completedAt, :safeReasonCode)",
    ).run({
      actorId: proposal.actorId, id: proposal.id, version: proposal.version, status: proposal.status,
      operation: proposal.operation, eventRef: proposal.eventRef ?? null, encryptedPayload: proposal.encryptedPayload ?? null,
      payloadPurgedAt: proposal.payloadPurgedAt ?? null, providerEtagCiphertext: proposal.providerEtagCiphertext ?? null,
      createdByActorType: proposal.createdByActorType, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt,
      completedAt: proposal.completedAt ?? null, safeReasonCode: proposal.safeReasonCode ?? null,
    });
    requireChanges(inserted.changes);
    const idempotency = database.prepare("INSERT INTO calendar_idempotency(actor_id, idempotency_key_hash, request_hash, proposal_id, created_at) VALUES(:actorId, :idempotencyKey, :requestHash, :proposalId, :createdAt)")
      .run({ actorId: proposal.actorId, idempotencyKey, requestHash, proposalId: proposal.id, createdAt: proposal.createdAt });
    requireChanges(idempotency.changes);
    return { kind: "inserted", proposal };
  },
  getProposal(database, actorId, proposalId) {
    return mapProposal(selectProposal(database, actorId, proposalId));
  },
  listExecutingProposals(database, limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("calendar_proposal_limit_invalid");
    return database.prepare("SELECT * FROM calendar_change_proposals WHERE status = 'executing' ORDER BY created_at, id LIMIT :limit")
      .all<ProposalRow>({ limit }).map((row) => mapProposal(row)!);
  },
  transitionProposal(database, input) {
    requireOwnedEventReference(database, input.actorId, input.eventRef);
    if (input.from.length === 0) fail("calendar_proposal_transition_invalid");
    const placeholders = input.from.map((_, index) => `:from${index}`).join(", ");
    const parameters: Record<string, string | number | null> = {
      actorId: input.actorId, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      to: input.to, eventRef: input.eventRef ?? null, completedAt: input.completedAt ?? null,
      safeReasonCode: input.safeReasonCode ?? null,
    };
    input.from.forEach((status, index) => { parameters[`from${index}`] = status; });
    const updated = database.prepare(
      `UPDATE calendar_change_proposals SET status = :to, version = version + 1, event_ref = COALESCE(:eventRef, event_ref), completed_at = COALESCE(:completedAt, completed_at), safe_reason_code = :safeReasonCode WHERE actor_id = :actorId AND id = :proposalId AND version = :expectedVersion AND status IN (${placeholders})`,
    ).run(parameters);
    requireChanges(updated.changes, "calendar_proposal_transition_conflict");
    const result = mapProposal(selectProposal(database, input.actorId, input.proposalId));
    return result ?? fail("calendar_proposal_transition_conflict");
  },
  appendAudit(database, record) {
    const result = database.prepare("INSERT INTO calendar_change_audit(id, actor_id, proposal_id, operation, outcome, request_id, occurred_at) VALUES(:id, :actorId, :proposalId, :operation, :outcome, :requestId, :occurredAt)")
      .run({ id: record.id, actorId: record.actorId, proposalId: record.proposalId ?? null, operation: record.operation, outcome: record.outcome, requestId: record.requestId, occurredAt: record.occurredAt });
    requireChanges(result.changes);
  },
  expirePendingProposals(database, now) {
    return database.prepare("UPDATE calendar_change_proposals SET status = 'expired', version = version + 1, completed_at = :now, safe_reason_code = 'proposal_expired' WHERE status = 'pending' AND expires_at <= :now")
      .run({ now }).changes;
  },
  purgeOAuthTransactions(database, olderThan) {
    return database.prepare("DELETE FROM calendar_oauth_transactions WHERE expires_at <= :olderThan").run({ olderThan }).changes;
  },
  purgeStaleEventReferences(database, olderThan) {
    return database.prepare("DELETE FROM calendar_event_refs WHERE last_observed_at < :olderThan").run({ olderThan }).changes;
  },
  purgeTerminalProposalPayloads(database, olderThan) {
    return database.prepare("UPDATE calendar_change_proposals SET encrypted_payload = NULL, payload_purged_at = :olderThan WHERE status IN ('completed', 'rejected', 'expired', 'conflict', 'failed') AND encrypted_payload IS NOT NULL AND COALESCE(completed_at, expires_at) <= :olderThan")
      .run({ olderThan }).changes;
  },
  purgeIdempotencyRecords(database, olderThan) {
    return database.prepare("DELETE FROM calendar_idempotency WHERE created_at < :olderThan").run({ olderThan }).changes;
  },
});
