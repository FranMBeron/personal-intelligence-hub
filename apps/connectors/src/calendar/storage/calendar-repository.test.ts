import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openCalendarValue, sealCalendarValue, type CalendarKeyring } from "../crypto/envelope.js";
import { openConnectorDatabase, type ConnectorDatabase, type SqliteHandle } from "../../foundation/database.js";
import { applyMigrations, loadMigrations } from "../../foundation/migrations.js";
import { createCalendarRepository } from "./calendar-repository.js";
import type {
  CalendarConnectionInput,
  CalendarRecord,
  EventReferenceRecord,
  ProposalRecord,
  SanitizedCalendarAuditRecord,
} from "./records.js";

const databases: ConnectorDatabase[] = [];
const directories: string[] = [];
const now = "2026-10-12T12:00:00.000Z";
const later = "2026-10-12T12:10:00.000Z";
const systemTransition = { now, requestId: "request-system" };
const actorId = "actor-fictional-01";
const otherActor = "actor-fictional-02";
const ring: CalendarKeyring = {
  activeKeyId: "calendar-key-v1",
  keys: new Map([["calendar-key-v1", new Uint8Array(32).fill(7)]]),
  blindIndexKey: new Uint8Array(32).fill(9),
};
const repository = createCalendarRepository();
const authorizationIdOf = (db: SqliteHandle, actor = actorId): string => {
  const current = repository.getConnection(db, actor);
  if (current === null) throw new Error("fixture_connection_missing");
  return current.authorizationId;
};

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pih-calendar-repository-"));
  directories.push(directory);
  const databasePath = join(directory, "connectors.sqlite");
  const database = openConnectorDatabase(databasePath);
  databases.push(database);
  await database.read(() => undefined);
  return { database, databasePath };
};

const connection = (overrides: Partial<CalendarConnectionInput> = {}): CalendarConnectionInput => ({
  actorId,
  state: "available",
  refreshTokenCiphertext: sealCalendarValue("fictional-refresh-token", `calendar_connections:${actorId}:refresh`, ring),
  grantedScopes: ["calendar.readonly"],
  selectionVersion: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const calendar = (
  overrides: Partial<CalendarRecord> = {},
): CalendarRecord => ({
  actorId,
  calendarRef: "calendar-ref-01",
  providerCalendarIdCiphertext: sealCalendarValue("provider-calendar-01", `calendar_allowlist:${actorId}:provider-id`, ring),
  providerCalendarBlindIndex: "blind-calendar-01",
  displayNameCiphertext: sealCalendarValue("Fictional calendar", `calendar_allowlist:${actorId}:display-name`, ring),
  providerAccessRole: "writer",
  readEnabled: true,
  writeEnabled: true,
  isPrimary: true,
  lastVerifiedAt: now,
  ...overrides,
});

const eventReference = (overrides: Partial<EventReferenceRecord> = {}): EventReferenceRecord => ({
  actorId,
  eventRef: "event-ref-01",
  calendarRef: "calendar-ref-01",
  providerEventIdCiphertext: sealCalendarValue("provider-event-01", `calendar_event_refs:${actorId}:provider-id`, ring),
  providerEventBlindIndex: "blind-event-01",
  lastObservedAt: now,
  ...overrides,
});

const proposal = (overrides: Partial<ProposalRecord> = {}): ProposalRecord => ({
  actorId,
  id: "proposal-01",
  version: 1,
  status: "pending",
  operation: "create",
  encryptedPayload: sealCalendarValue("fictional-event-payload", `calendar_change_proposals:${actorId}:proposal-01:payload`, ring),
  createdByActorType: "human",
  createdAt: now,
  expiresAt: "2026-10-12T13:00:00.000Z",
  ...overrides,
});

const auditRecord = (overrides: Partial<SanitizedCalendarAuditRecord> = {}): SanitizedCalendarAuditRecord => ({
  id: "audit-01",
  actorId,
  operation: "create",
  outcome: "proposed",
  requestId: "request-01",
  occurredAt: now,
  ...overrides,
});

const seedConnection = async (database: ConnectorDatabase, actor = actorId) =>
  database.write((db) => repository.saveConnection(db, connection({ actorId: actor })));

const count = async (database: ConnectorDatabase, table: string) =>
  database.read((db) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get<{ count: number }>()?.count);

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Calendar repository", () => {
  it("consumes OAuth state once and binds it to the initiating actor", async () => {
    const { database } = await createDatabase();
    const transaction = {
      stateHash: "state-hash-01",
      actorId,
      verifierCiphertext: "v1.fixture.nonce.ciphertext.tag",
      expiresAt: "2026-10-12T12:05:00.000Z",
    };
    await database.transaction((db) => repository.createOAuthTransaction(db, transaction));

    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now))).resolves.toMatchObject({ actorId });
    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now))).resolves.toBeNull();
    await expect(database.transaction((db) => repository.consumeOAuthTransaction(db, transaction.stateHash, otherActor, now))).resolves.toBeNull();
  });

  it("allows safe same-actor replay only after authorization completion and before expiry", async () => {
    const { database } = await createDatabase();
    const transaction = { stateHash: "state-hash-replay", actorId, verifierCiphertext: "v1.fixture.nonce.ciphertext.tag", expiresAt: "2026-10-12T12:30:00.000Z" };
    await database.transaction((db) => {
      repository.createOAuthTransaction(db, transaction);
      repository.consumeOAuthTransaction(db, transaction.stateHash, actorId, now);
      repository.markOAuthAuthorizationCompleted(db, transaction.stateHash, later);
    });

    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, actorId, later))).resolves.toMatchObject({ authorizationCompletedAt: later });
    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, otherActor, later))).resolves.toBeNull();
    await expect(database.read((db) => repository.getOAuthTransactionReplay(db, transaction.stateHash, actorId, "2026-10-12T12:31:00.000Z"))).resolves.toBeNull();
  });

  it("rejects duplicate provider calendar identities by actor-scoped blind index", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition));
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 2 });
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [
      calendar({ calendarRef: "calendar-ref-02" }),
      calendar({ calendarRef: "calendar-ref-03" }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();
    await expect(count(database, "calendar_allowlist")).resolves.toBe(1);
  });

  it("rejects calendar rows supplied for a different actor", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.write((db) => repository.saveConnection(db, connection({ actorId: otherActor })));
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition));

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [
      calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();

    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toMatchObject([
      { actorId, calendarRef: "calendar-ref-01" },
    ]);
    await expect(database.read((db) => repository.listCalendars(db, otherActor))).resolves.toEqual([]);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 2 });
  });

  it("rejects selection version conflicts without changing the saved selection", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition));
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [], authorizationIdOf(db), systemTransition))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toHaveLength(1);
  });

  it("requires exactly one selected primary calendar with read or write enabled", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ calendarRef: "calendar-ref-01", isPrimary: true }),
      calendar({ calendarRef: "calendar-ref-02", isPrimary: true, providerCalendarBlindIndex: "blind-calendar-02" }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ readEnabled: false, writeEnabled: false, isPrimary: true }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();
  });

  it("enforces write-role and boolean constraints in SQLite", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ providerAccessRole: "reader", writeEnabled: true }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1 });

    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [
      calendar({ readEnabled: 2 as unknown as boolean }),
    ], authorizationIdOf(db), systemTransition))).rejects.toThrow();
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
  });

  it("keeps primary-calendar binding encrypted and actor-bound", async () => {
    const { database } = await createDatabase();
    const binding = sealCalendarValue("provider-primary-calendar", `calendar_connections:${actorId}:primary-calendar`, ring);
    await database.write((db) => repository.saveConnection(db, connection({ primaryCalendarBindingCiphertext: binding })));

    const saved = await database.read((db) => repository.getConnection(db, actorId));
    expect(saved?.primaryCalendarBindingCiphertext).toBe(binding);
    expect(openCalendarValue(saved!.primaryCalendarBindingCiphertext!, `calendar_connections:${actorId}:primary-calendar`, ring)).toBe("provider-primary-calendar");
    expect(() => openCalendarValue(saved!.primaryCalendarBindingCiphertext!, `calendar_connections:${otherActor}:primary-calendar`, ring)).toThrow();
  });

  it("resolves allowlisted calendars and event references only for their actor", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
    });

    await expect(database.read((db) => repository.resolveCalendar(db, actorId, "calendar-ref-01"))).resolves.toMatchObject({ actorId });
    await expect(database.read((db) => repository.resolveCalendar(db, otherActor, "calendar-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toMatchObject({ calendarRef: "calendar-ref-01" });
    await expect(database.read((db) => repository.resolveEvent(db, otherActor, "event-ref-01"))).resolves.toBeNull();
  });

  it("replays matching idempotency keys and conflicts on a different request hash", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const first = proposal();
    await expect(database.transaction((db) => repository.insertProposal(db, first, "idempotency-hash-01", "request-hash-01"))).resolves.toMatchObject({ kind: "inserted" });
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-02" }), "idempotency-hash-01", "request-hash-01"))).resolves.toMatchObject({ kind: "replayed", proposal: { id: "proposal-01" } });
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-03" }), "idempotency-hash-01", "different-request-hash"))).resolves.toEqual({ kind: "conflict" });
  });

  it("looks up an idempotent proposal by actor-scoped key hash without inserting", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await expect(database.read((db) => repository.findProposalByIdempotencyKey(db, actorId, "idempotency-lookup"))).resolves.toBeNull();
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-lookup", "request-hash-lookup"));
    await expect(database.read((db) => repository.findProposalByIdempotencyKey(db, actorId, "idempotency-lookup")))
      .resolves.toMatchObject({ requestHash: "request-hash-lookup", proposal: { id: "proposal-01", actorId } });
    await expect(database.read((db) => repository.findProposalByIdempotencyKey(db, otherActor, "idempotency-lookup"))).resolves.toBeNull();
    expect(await count(database, "calendar_idempotency")).toBe(1);
  });

  it("uses compare-and-set versions for proposal state transitions", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-hash-transition", "request-hash-transition"));
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "executing",
    }))).resolves.toMatchObject({ version: 2, status: "executing" });
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "rejected",
    }))).rejects.toThrow();
    await expect(database.read((db) => repository.getProposal(db, otherActor, "proposal-01"))).resolves.toBeNull();
  });

  it("refuses a transition guarded by expiry once expires_at has passed", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-hash-expiry", "request-hash-expiry"));
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "executing", unexpiredAt: "2026-10-12T13:00:00.000Z",
    }))).rejects.toThrow("calendar_proposal_expired");
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({ status: "pending", version: 1 });
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "executing", unexpiredAt: "2026-10-12T12:59:59.999Z",
    }))).resolves.toMatchObject({ status: "executing", version: 2 });
  });

  it("enumerates executing proposals in stable order with a strict bound", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      for (const [id, createdAt] of [["proposal-b", later], ["proposal-a", now], ["proposal-c", now]] as const) {
        repository.insertProposal(db, proposal({ id, status: "executing", createdAt }), `idem-${id}`, `hash-${id}`);
      }
    });

    await expect(database.read((db) => repository.listExecutingProposals(db, 2))).resolves.toMatchObject([
      { id: "proposal-a" }, { id: "proposal-c" },
    ]);
    await expect(database.read((db) => repository.listExecutingProposals(db, 2, { createdAt: now, id: "proposal-a", actorId })))
      .resolves.toMatchObject([{ id: "proposal-c" }, { id: "proposal-b" }]);
    await expect(database.read((db) => repository.listExecutingProposals(db, 2, { createdAt: later, id: "proposal-b", actorId })))
      .resolves.toEqual([]);
    await expect(database.read((db) => repository.listExecutingProposals(db, 0))).rejects.toThrow();
    await expect(database.read((db) => repository.listExecutingProposals(db, 101))).rejects.toThrow();
  });

  it("expires pending proposals and purges only records beyond each cutoff", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.createOAuthTransaction(db, { stateHash: "old-state", actorId, verifierCiphertext: "fixture", expiresAt: "2026-10-12T11:00:00.000Z" });
      repository.createOAuthTransaction(db, { stateHash: "new-state", actorId, verifierCiphertext: "fixture", expiresAt: "2026-10-12T13:00:00.000Z" });
      repository.insertProposal(db, proposal({ id: "old-pending", expiresAt: "2026-10-12T11:00:00.000Z" }), "idem-old-pending", "hash-old-pending");
      repository.insertProposal(db, proposal({ id: "new-pending", expiresAt: "2026-10-12T13:00:00.000Z" }), "idem-new-pending", "hash-new-pending");
    });

    await expect(database.write((db) => repository.expirePendingProposals(db, { now, requestId: "request-retention" }))).resolves.toBe(1);
    await expect(database.write((db) => repository.purgeOAuthTransactions(db, "2026-10-12T12:00:00.000Z"))).resolves.toBe(1);
    await expect(count(database, "calendar_oauth_transactions")).resolves.toBe(1);
    await expect(database.read((db) => repository.getProposal(db, actorId, "old-pending"))).resolves.toMatchObject({ status: "expired" });
  });

  it("purges terminal encrypted payloads with retention metadata while preserving proposal metadata", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => repository.insertProposal(db, proposal({
      status: "completed",
      completedAt: "2026-10-01T00:00:00.000Z",
      encryptedPayload: sealCalendarValue("old-payload", `calendar_change_proposals:${actorId}:proposal-purge:payload`, ring),
    }), "idempotency-purge", "request-purge"));

    await expect(database.write((db) => repository.purgeTerminalProposalPayloads(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    const purged = await database.read((db) => repository.getProposal(db, actorId, "proposal-01"));
    expect(purged?.encryptedPayload).toBeUndefined();
    expect(purged).toMatchObject({ payloadPurgedAt: "2026-10-10T00:00:00.000Z", status: "completed" });
  });

  it("preserves active proposals and idempotency when saving the same selection again", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const selectedCalendar = calendar();
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [selectedCalendar], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idempotency-resave", "request-resave");
    });

    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [selectedCalendar], authorizationIdOf(db), systemTransition));

    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.not.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({ status: "pending", eventRef: "event-ref-01" });
    await expect(count(database, "calendar_idempotency")).resolves.toBe(1);
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 3 });
  });

  it("preserves terminal proposals and idempotency when stale event references are purged", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-10-01T00:00:00.000Z" }));
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01", status: "completed", completedAt: now }), "idempotency-stale-event", "request-stale-event");
    });

    await expect(database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({ status: "completed", retainedEventRef: "event-ref-01" });
    await expect(count(database, "calendar_idempotency")).resolves.toBe(1);
  });

  it("rejects pending proposals in the application and only detaches the rest when their calendar is deselected and reselected", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const primary = calendar();
    const secondary = calendar({ calendarRef: "calendar-ref-02", providerCalendarBlindIndex: "blind-calendar-02", isPrimary: false });
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [primary, secondary], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ calendarRef: "calendar-ref-02" }));
      repository.insertProposal(db, proposal({ id: "proposal-pending", operation: "update", eventRef: "event-ref-01" }), "idem-deselect-pending", "hash-deselect-pending");
      repository.insertProposal(db, proposal({ id: "proposal-done", operation: "update", status: "completed", completedAt: now, eventRef: "event-ref-01" }), "idem-deselect-done", "hash-deselect-done");
    });

    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [primary], authorizationIdOf(db), { now: later, requestId: "request-deselect" }));

    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    const pending = await database.read((db) => repository.getProposal(db, actorId, "proposal-pending"));
    expect(pending).toMatchObject({
      status: "rejected", version: 2, safeReasonCode: "provider_state_changed", completedAt: later, retainedEventRef: "event-ref-01",
    });
    expect(pending?.eventRef).toBeUndefined();
    const done = await database.read((db) => repository.getProposal(db, actorId, "proposal-done"));
    expect(done).toMatchObject({ status: "completed", version: 1, completedAt: now, retainedEventRef: "event-ref-01" });
    expect(done?.eventRef).toBeUndefined();
    expect(done?.safeReasonCode).toBeUndefined();
    const audit = await database.read((db) => db.prepare("SELECT * FROM calendar_change_audit ORDER BY occurred_at, id").all<Record<string, unknown>>());
    expect(audit).toEqual([{
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      actor_id: actorId, proposal_id: "proposal-pending", operation: "update", outcome: "rejected",
      request_id: "request-deselect", occurred_at: later,
    }]);

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending", expectedVersion: 2, from: ["pending"], to: "executing",
    }))).rejects.toThrow("calendar_proposal_transition_conflict");

    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 3, [primary, secondary], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ calendarRef: "calendar-ref-02" }));
    });
    const reselected = await database.read((db) => repository.getProposal(db, actorId, "proposal-pending"));
    expect(reselected).toMatchObject({ status: "rejected", version: 2, retainedEventRef: "event-ref-01" });
    expect(reselected?.eventRef).toBeUndefined();
    await expect(count(database, "calendar_change_audit")).resolves.toBe(1);
    await expect(count(database, "calendar_idempotency")).resolves.toBe(2);
    await expect(database.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
  });

  it("only detaches an executing proposal on deselection and lets the executor settle it from its retained reference", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const primary = calendar();
    const secondary = calendar({ calendarRef: "calendar-ref-02", providerCalendarBlindIndex: "blind-calendar-02", isPrimary: false });
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [primary, secondary], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ calendarRef: "calendar-ref-02" }));
      repository.insertProposal(db, proposal({ id: "proposal-executing", operation: "update", status: "executing", eventRef: "event-ref-01" }), "idem-deselect-executing", "hash-deselect-executing");
    });

    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [primary], authorizationIdOf(db), systemTransition));

    const executing = await database.read((db) => repository.getProposal(db, actorId, "proposal-executing"));
    expect(executing).toMatchObject({ status: "executing", version: 1, retainedEventRef: "event-ref-01" });
    expect(executing?.eventRef).toBeUndefined();
    expect(executing?.completedAt).toBeUndefined();
    expect(executing?.safeReasonCode).toBeUndefined();
    await expect(count(database, "calendar_change_audit")).resolves.toBe(0);
    await expect(database.read((db) => repository.listExecutingProposals(db, 10))).resolves.toEqual([executing]);

    const settled = await database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-executing", expectedVersion: 1, from: ["executing"], to: "completed",
      eventRef: "event-ref-01", completedAt: later,
    }));
    expect(settled).toMatchObject({ status: "completed", version: 2, completedAt: later, retainedEventRef: "event-ref-01" });
    expect(settled.eventRef).toBeUndefined();
    await expect(database.read((db) => repository.listExecutingProposals(db, 10))).resolves.toEqual([]);
    await expect(count(database, "calendar_idempotency")).resolves.toBe(1);
  });

  it("stamps system rejections with the injected clock so payload retention counts from it", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const primary = calendar();
    const secondary = calendar({ calendarRef: "calendar-ref-02", providerCalendarBlindIndex: "blind-calendar-02", isPrimary: false });
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [primary, secondary], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ calendarRef: "calendar-ref-02" }));
      repository.insertProposal(db, proposal({ id: "proposal-clock", operation: "update", eventRef: "event-ref-01" }), "idem-clock", "hash-clock");
    });
    const fakeNow = "2020-01-01T00:00:00.000Z";

    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [primary], authorizationIdOf(db), { now: fakeNow, requestId: "request-clock" }));

    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-clock"))).resolves.toMatchObject({ status: "rejected", completedAt: fakeNow });
    // The retention service purges 30 days after the terminal state; run it 31 days after the fake clock.
    const day = 24 * 60 * 60 * 1000;
    const retentionCutoff = new Date(Date.parse(fakeNow) + 31 * day - 30 * day).toISOString();
    await expect(database.write((db) => repository.purgeTerminalProposalPayloads(db, retentionCutoff))).resolves.toBe(1);
    const purged = await database.read((db) => repository.getProposal(db, actorId, "proposal-clock"));
    expect(purged?.encryptedPayload).toBeUndefined();
    expect(purged).toMatchObject({ status: "rejected", payloadPurgedAt: retentionCutoff });
  });

  it("treats a rebound calendar (changed blind index) exactly like a deselection", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ id: "proposal-rebind-pending", operation: "cancel", eventRef: "event-ref-01" }), "idem-rebind-pending", "hash-rebind-pending");
      repository.insertProposal(db, proposal({ id: "proposal-rebind-executing", operation: "update", status: "executing", eventRef: "event-ref-01" }), "idem-rebind-executing", "hash-rebind-executing");
    });

    await database.transaction((db) => repository.replaceCalendarSelection(
      db, actorId, 2, [calendar({ providerCalendarBlindIndex: "blind-calendar-rebound" })], authorizationIdOf(db), { now: later, requestId: "request-rebind" },
    ));

    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    const pending = await database.read((db) => repository.getProposal(db, actorId, "proposal-rebind-pending"));
    expect(pending).toMatchObject({
      status: "rejected", version: 2, safeReasonCode: "provider_state_changed", completedAt: later, retainedEventRef: "event-ref-01",
    });
    expect(pending?.eventRef).toBeUndefined();
    const executing = await database.read((db) => repository.getProposal(db, actorId, "proposal-rebind-executing"));
    expect(executing).toMatchObject({ status: "executing", version: 1, retainedEventRef: "event-ref-01" });
    expect(executing?.eventRef).toBeUndefined();
    const audit = await database.read((db) => db.prepare("SELECT proposal_id, operation, outcome, request_id, occurred_at FROM calendar_change_audit").all<Record<string, unknown>>());
    expect(audit).toEqual([{ proposal_id: "proposal-rebind-pending", operation: "cancel", outcome: "rejected", request_id: "request-rebind", occurred_at: later }]);
    await expect(count(database, "calendar_idempotency")).resolves.toBe(2);
    await expect(database.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
  });

  it("keeps stale event references that a live (pending or executing) proposal still uses", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-01-01T00:00:00.000Z" }));
      repository.insertProposal(db, proposal({ id: "proposal-live-pending", eventRef: "event-ref-01" }), "idem-live-pending", "hash-live-pending");
      repository.insertProposal(db, proposal({ id: "proposal-live-executing", status: "executing", eventRef: "event-ref-01" }), "idem-live-executing", "hash-live-executing");
    });

    await expect(database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(0);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.not.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-live-pending"))).resolves.toMatchObject({ status: "pending", eventRef: "event-ref-01" });
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-live-executing"))).resolves.toMatchObject({ status: "executing", eventRef: "event-ref-01" });
  });

  it("purges stale event references and aged idempotency rows at cutoffs", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-10-01T00:00:00.000Z" }));
    });
    await database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-idem-purge", createdAt: "2026-10-01T00:00:00.000Z" }), "idempotency-aged", "request-aged"));

    await expect(database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(database.write((db) => repository.purgeIdempotencyRecords(db, "2026-10-10T00:00:00.000Z"))).resolves.toBe(1);
    await expect(count(database, "calendar_event_refs")).resolves.toBe(0);
  });

  it("stores only content-free audit fields and retains audit rows on disconnect", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.write((db) => repository.appendAudit(db, auditRecord()));
    const before = await database.read((db) => db.prepare("SELECT * FROM calendar_change_audit WHERE id = :id").get<Record<string, unknown>>({ id: "audit-01" }));
    expect(before).toEqual({
      id: "audit-01",
      actor_id: actorId,
      proposal_id: null,
      operation: "create",
      outcome: "proposed",
      request_id: "request-01",
      occurred_at: now,
    });
    await database.write((db) => repository.deleteConnection(db, actorId));
    await expect(count(database, "calendar_connections")).resolves.toBe(0);
    await expect(count(database, "calendar_change_audit")).resolves.toBe(1);
  });

  it("replaces authorization atomically and clears old account-bound state but preserves audit", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.appendAudit(db, auditRecord());
    });
    await database.transaction((db) => repository.insertProposal(db, proposal(), "idempotency-old", "request-old"));

    await database.transaction((db) => repository.replaceConnectionAuthorization(db, connection({
      refreshTokenCiphertext: sealCalendarValue("rotated-refresh-token", `calendar_connections:${actorId}:refresh`, ring),
      selectionVersion: 1,
      updatedAt: later,
    })));

    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1, state: "available" });
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
    await expect(database.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.toBeNull();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toBeNull();
    await expect(count(database, "calendar_idempotency")).resolves.toBe(0);
    await expect(count(database, "calendar_change_audit")).resolves.toBe(1);
  });

  it("upgrades a 0200 database additively and then retains proposals when event references are purged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pih-calendar-upgrade-"));
    directories.push(directory);
    const databasePath = join(directory, "connectors.sqlite");
    // A 0200-era database holds the exact packaged prefix up to and including 0200_calendar.
    const oldMigrations = loadMigrations().filter(({ name }) => name <= "0200_calendar");
    const oldDatabase = openConnectorDatabase(databasePath, oldMigrations);
    databases.push(oldDatabase);
    await oldDatabase.transaction((db) => {
      const legacy = connection();
      db.prepare(
        "INSERT INTO calendar_connections(actor_id, state, refresh_token_ciphertext, granted_scopes_json, selection_version, created_at, updated_at) " +
        "VALUES(:actorId, :state, :refreshTokenCiphertext, :grantedScopesJson, :selectionVersion, :createdAt, :updatedAt)",
      ).run({
        actorId: legacy.actorId, state: legacy.state, refreshTokenCiphertext: legacy.refreshTokenCiphertext,
        grantedScopesJson: JSON.stringify(legacy.grantedScopes), selectionVersion: legacy.selectionVersion,
        createdAt: legacy.createdAt, updatedAt: legacy.updatedAt,
      });
      const selected = calendar();
      db.prepare(
        "INSERT INTO calendar_allowlist(actor_id, calendar_ref, provider_calendar_id_ciphertext, provider_calendar_blind_index, display_name_ciphertext, provider_access_role, read_enabled, write_enabled, is_primary, last_verified_at) " +
        "VALUES(:actorId, :calendarRef, :providerCalendarIdCiphertext, :providerCalendarBlindIndex, :displayNameCiphertext, :providerAccessRole, 1, 1, 1, :lastVerifiedAt)",
      ).run({
        actorId: selected.actorId, calendarRef: selected.calendarRef,
        providerCalendarIdCiphertext: selected.providerCalendarIdCiphertext,
        providerCalendarBlindIndex: selected.providerCalendarBlindIndex,
        displayNameCiphertext: selected.displayNameCiphertext,
        providerAccessRole: selected.providerAccessRole, lastVerifiedAt: selected.lastVerifiedAt,
      });
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idempotency-migration", "request-migration");
    });
    await oldDatabase.close();
    databases.splice(databases.indexOf(oldDatabase), 1);

    const upgraded = openConnectorDatabase(databasePath);
    databases.push(upgraded);
    await expect(upgraded.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({
      eventRef: "event-ref-01", status: "pending",
    });
    await expect(upgraded.read((db) => repository.resolveEvent(db, actorId, "event-ref-01"))).resolves.not.toBeNull();
    await expect(count(upgraded, "calendar_idempotency")).resolves.toBe(1);
    await expect(upgraded.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
    await expect(upgraded.write((db) => repository.purgeStaleEventReferences(db, "2026-10-13T00:00:00.000Z"))).resolves.toBe(0);
    await upgraded.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-01", expectedVersion: 1, from: ["pending"], to: "rejected",
    }));
    await expect(upgraded.write((db) => repository.purgeStaleEventReferences(db, "2026-10-13T00:00:00.000Z"))).resolves.toBe(1);
    await expect(upgraded.read((db) => repository.getProposal(db, actorId, "proposal-01"))).resolves.toMatchObject({
      retainedEventRef: "event-ref-01", status: "rejected",
    });
    await expect(count(upgraded, "calendar_idempotency")).resolves.toBe(1);
    const migrated = await upgraded.read((db) => repository.getConnection(db, actorId));
    expect(migrated?.authorizationId).toMatch(/^[0-9a-f]{32}$/u);
    await upgraded.write((db) => db.prepare(
      "INSERT INTO calendar_connections(actor_id, state, refresh_token_ciphertext, granted_scopes_json, selection_version, created_at, updated_at) " +
      "VALUES(:actorId, 'available', 'legacy-ciphertext', '[]', 1, :now, :now)",
    ).run({ actorId: otherActor, now: later }));
    const legacyInsert = await upgraded.read((db) => repository.getConnection(db, otherActor));
    expect(legacyInsert?.authorizationId).toMatch(/^[0-9a-f]{32}$/u);
    expect(legacyInsert?.authorizationId).not.toBe(migrated?.authorizationId);
  });

  it("lets an older runtime write, deselect and purge against the migrated schema without losing proposals", async () => {
    const { database } = await createDatabase();
    // Only SQL an older calendar runtime issues: 0200 column lists, no
    // authorization_id, no retained_event_ref.
    await database.transaction((db) => {
      db.prepare(
        "INSERT INTO calendar_connections(actor_id, state, refresh_token_ciphertext, granted_scopes_json, selection_version, created_at, updated_at) " +
        "VALUES(:actorId, 'available', 'legacy-ciphertext', '[]', 1, :now, :now)",
      ).run({ actorId, now });
      const insertCalendar = db.prepare(
        "INSERT INTO calendar_allowlist(actor_id, calendar_ref, provider_calendar_id_ciphertext, provider_calendar_blind_index, display_name_ciphertext, provider_access_role, read_enabled, write_enabled, is_primary, last_verified_at) " +
        "VALUES(:actorId, :calendarRef, 'legacy-id', :blind, 'legacy-name', 'writer', 1, 1, :isPrimary, :now)",
      );
      insertCalendar.run({ actorId, calendarRef: "calendar-ref-01", blind: "blind-calendar-01", isPrimary: 1, now });
      insertCalendar.run({ actorId, calendarRef: "calendar-ref-02", blind: "blind-calendar-02", isPrimary: 0, now });
      const insertEvent = db.prepare(
        "INSERT INTO calendar_event_refs(actor_id, event_ref, calendar_ref, provider_event_id_ciphertext, provider_event_blind_index, last_observed_at) " +
        "VALUES(:actorId, :eventRef, :calendarRef, 'legacy-event', :blind, :observed)",
      );
      insertEvent.run({ actorId, eventRef: "event-ref-01", calendarRef: "calendar-ref-01", blind: "blind-event-01", observed: "2026-10-01T00:00:00.000Z" });
      insertEvent.run({ actorId, eventRef: "event-ref-02", calendarRef: "calendar-ref-02", blind: "blind-event-02", observed: now });
      const insertProposal = db.prepare(
        "INSERT INTO calendar_change_proposals(actor_id, id, version, status, operation, event_ref, encrypted_payload, payload_purged_at, provider_etag_ciphertext, created_by_actor_type, created_at, expires_at, completed_at, safe_reason_code) " +
        "VALUES(:actorId, :id, 1, 'pending', 'update', :eventRef, 'legacy-payload', NULL, NULL, 'human', :now, :expires, NULL, NULL)",
      );
      const insertKey = db.prepare(
        "INSERT INTO calendar_idempotency(actor_id, idempotency_key_hash, request_hash, proposal_id, created_at) VALUES(:actorId, :key, 'request-hash', :id, :now)",
      );
      for (const [id, eventRef] of [["proposal-01", "event-ref-01"], ["proposal-02", "event-ref-02"]] as const) {
        insertProposal.run({ actorId, id, eventRef, now, expires: "2026-10-12T13:00:00.000Z" });
        insertKey.run({ actorId, key: `key-${id}`, id, now });
      }
    });

    await expect(database.write((db) => db.prepare("DELETE FROM calendar_event_refs WHERE last_observed_at < :olderThan")
      .run({ olderThan: "2026-10-10T00:00:00.000Z" }).changes)).resolves.toBe(1);
    await database.write((db) => db.prepare("DELETE FROM calendar_allowlist WHERE actor_id = :actorId AND calendar_ref = 'calendar-ref-02'").run({ actorId }));

    await expect(count(database, "calendar_event_refs")).resolves.toBe(0);
    await expect(count(database, "calendar_change_proposals")).resolves.toBe(2);
    await expect(count(database, "calendar_idempotency")).resolves.toBe(2);
    await expect(database.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
    // The detach trigger only detaches, so the older runtime's compare-and-set
    // still applies and proposals keep the status the runtime gave them.
    await expect(database.transaction((db) => db.prepare(
      "UPDATE calendar_change_proposals SET status = 'rejected', version = version + 1 WHERE actor_id = :actorId AND id = 'proposal-01' AND version = 1",
    ).run({ actorId }).changes)).resolves.toBe(1);
    const first = await database.read((db) => repository.getProposal(db, actorId, "proposal-01"));
    expect(first).toMatchObject({ retainedEventRef: "event-ref-01", status: "rejected", version: 2 });
    expect(first?.eventRef).toBeUndefined();
    const second = await database.read((db) => repository.getProposal(db, actorId, "proposal-02"));
    expect(second).toMatchObject({ retainedEventRef: "event-ref-02", status: "pending", version: 1 });
    expect(second?.eventRef).toBeUndefined();
    expect(second?.safeReasonCode).toBeUndefined();
    await expect(count(database, "calendar_idempotency")).resolves.toBe(2);
    await expect(database.read((db) => db.prepare("PRAGMA foreign_key_check").all())).resolves.toEqual([]);
  });

  it("assigns a fresh authorization id on every replacement, even with identical metadata", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    const original = await database.read((db) => repository.getConnection(db, actorId));
    const returned = await database.transaction((db) => repository.replaceConnectionAuthorization(db, original!));
    const replaced = await database.read((db) => repository.getConnection(db, actorId));
    expect(replaced!.authorizationId).toBe(returned);
    expect(replaced!.authorizationId).not.toBe(original!.authorizationId);
    const { authorizationId: _originalId, ...originalFields } = original!;
    const { authorizationId: _replacedId, ...replacedFields } = replaced!;
    expect(replacedFields).toEqual(originalFields);
    await expect(database.transaction((db) => repository.saveConnectionIfUnchanged(db, original!, { ...original!, updatedAt: later })))
      .resolves.toBe(false);
    await database.write((db) => repository.saveConnection(db, { ...replaced!, state: "degraded" }));
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ authorizationId: returned });
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()], original!.authorizationId, systemTransition)))
      .rejects.toThrow("calendar_connection_changed");
    await expect(database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 1, [calendar()], returned, systemTransition)))
      .resolves.toBe(2);
  });

  it("always enforces the authorization binding when replacing a selection", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await expect(database.transaction((db) =>
      // @ts-expect-error expectedAuthorizationId is required; omitting it must not bypass the binding.
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()])))
      .rejects.toThrow("calendar_connection_changed");
    await expect(database.read((db) => repository.getConnection(db, actorId))).resolves.toMatchObject({ selectionVersion: 1 });
    await expect(database.read((db) => repository.listCalendars(db, actorId))).resolves.toEqual([]);
  });

  it("reopens the same file without reapplying migrations", async () => {
    const { database, databasePath } = await createDatabase();
    await applyMigrations(database, loadMigrations());
    await database.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = openConnectorDatabase(databasePath);
    databases.push(reopened);
    await expect(reopened.read((db) => db.prepare("SELECT count(*) AS count FROM calendar_connections").get<{ count: number }>()?.count)).resolves.toBe(0);
    await reopened.close();
    databases.splice(databases.indexOf(reopened), 1);
  });
});

describe("proposal event ownership", () => {
  it("rejects inserting proposals that reference missing or another actor's events", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })], authorizationIdOf(db, otherActor), systemTransition);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
    });

    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-missing-event", eventRef: "missing-event-ref" }), "idem-missing-event", "hash-missing-event"))).rejects.toThrow();
    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-foreign-event", eventRef: "foreign-event-ref" }), "idem-foreign-event", "hash-foreign-event"))).rejects.toThrow();
    await expect(count(database, "calendar_change_proposals")).resolves.toBe(0);
  });

  it("rejects assigning missing or another actor's events during proposal transitions", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })], authorizationIdOf(db, otherActor), systemTransition);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
      repository.insertProposal(db, proposal({ id: "proposal-transition-ref" }), "idem-transition-ref", "hash-transition-ref");
    });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "missing-event-ref",
    }))).rejects.toThrow();
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "foreign-event-ref",
    }))).rejects.toThrow();
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-transition-ref"))).resolves.toMatchObject({ status: "pending", version: 1 });
  });
});

describe("proposal foreign event ownership", () => {
  it("rejects inserting a proposal for another actor's event", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })], authorizationIdOf(db, otherActor), systemTransition);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
    });

    await expect(database.transaction((db) => repository.insertProposal(db, proposal({ id: "proposal-foreign-only", eventRef: "foreign-event-ref" }), "idem-foreign-only", "hash-foreign-only"))).rejects.toThrow();
  });

  it("rejects transitioning a proposal to another actor's event", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await seedConnection(database, otherActor);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.replaceCalendarSelection(db, otherActor, 1, [calendar({ actorId: otherActor, calendarRef: "foreign-calendar-ref" })], authorizationIdOf(db, otherActor), systemTransition);
      repository.upsertEventReference(db, eventReference({ actorId: otherActor, eventRef: "foreign-event-ref", calendarRef: "foreign-calendar-ref" }));
      repository.insertProposal(db, proposal(), "idem-transition-foreign", "hash-transition-foreign");
    });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-transition-ref", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "foreign-event-ref",
    }))).rejects.toThrow();
  });
});

describe("terminal transitions of detached proposals", () => {
  const seedExecuting = async (database: ConnectorDatabase) => {
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ id: "proposal-detached", status: "executing", operation: "update", eventRef: "event-ref-01" }), "idem-detached", "hash-detached");
    });
  };

  it("lets an in-flight proposal whose reference was detached reach a terminal state without re-attaching it", async () => {
    const { database } = await createDatabase();
    await seedExecuting(database);
    // An in-flight row detached without leaving `executing`, as the 0210
    // trigger leaves it when its reference is deleted.
    await database.write((db) => {
      db.prepare("UPDATE calendar_change_proposals SET retained_event_ref = event_ref, event_ref = NULL WHERE id = 'proposal-detached'").run();
      db.prepare("DELETE FROM calendar_event_refs WHERE event_ref = 'event-ref-01'").run();
    });

    const failed = await database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-detached", expectedVersion: 1, from: ["executing"], to: "failed",
      eventRef: "event-ref-01", completedAt: later, safeReasonCode: "provider_state_changed",
    }));
    expect(failed).toMatchObject({ status: "failed", version: 2, retainedEventRef: "event-ref-01", completedAt: later });
    expect(failed.eventRef).toBeUndefined();
  });

  it("reports a stale executor snapshot as a transition conflict, not a missing reference", async () => {
    const { database } = await createDatabase();
    await seedExecuting(database);
    await database.transaction((db) => repository.replaceCalendarSelection(db, actorId, 2, [calendar({ calendarRef: "calendar-ref-02", providerCalendarBlindIndex: "blind-calendar-02" })], authorizationIdOf(db), systemTransition));
    // The reconciler settles the detached row first; the executor's v1 snapshot is now stale.
    await database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-detached", expectedVersion: 1, from: ["executing"], to: "conflict", eventRef: "event-ref-01",
      completedAt: later, safeReasonCode: "provider_state_changed",
    }));

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-detached", expectedVersion: 1, from: ["executing"], to: "failed", eventRef: "event-ref-01",
    }))).rejects.toThrow("calendar_proposal_transition_conflict");
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-detached"))).resolves.toMatchObject({ status: "conflict", version: 2 });
  });

  const seedDetachedPending = async (database: ConnectorDatabase) => {
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.upsertEventReference(db, eventReference({ eventRef: "event-ref-other", providerEventBlindIndex: "blind-event-other" }));
      repository.insertProposal(db, proposal({ id: "proposal-pending-detached", operation: "update", eventRef: "event-ref-01" }), "idem-pending-detached", "hash-pending-detached");
    });
    // A pending row detached by a delete the application did not settle first (an older runtime, or retention).
    await database.write((db) => db.prepare("DELETE FROM calendar_event_refs WHERE event_ref = 'event-ref-01'").run());
  };

  it("never lets a detached pending proposal become executable", async () => {
    const { database } = await createDatabase();
    await seedDetachedPending(database);
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-pending-detached")))
      .resolves.toMatchObject({ status: "pending", version: 1, retainedEventRef: "event-ref-01" });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "executing",
    }))).rejects.toThrow("calendar_proposal_detached");
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "event-ref-other",
    }))).rejects.toThrow("calendar_proposal_detached");
    // Even once the same opaque reference is observed again, the detached row stays detached.
    await database.write((db) => repository.upsertEventReference(db, eventReference({ lastObservedAt: later })));
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "executing", eventRef: "event-ref-01",
    }))).rejects.toThrow("calendar_proposal_detached");
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "pending",
    }))).rejects.toThrow("calendar_proposal_detached");

    const unchanged = await database.read((db) => repository.getProposal(db, actorId, "proposal-pending-detached"));
    expect(unchanged).toMatchObject({ status: "pending", version: 1, retainedEventRef: "event-ref-01" });
    expect(unchanged?.eventRef).toBeUndefined();
  });

  it("settles a detached proposal only under its own retained reference", async () => {
    const { database } = await createDatabase();
    await seedDetachedPending(database);
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "rejected", eventRef: "event-ref-other",
    }))).rejects.toThrow("calendar_proposal_detached");

    const rejected = await database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-pending-detached", expectedVersion: 1, from: ["pending"], to: "rejected",
      completedAt: later, safeReasonCode: "provider_state_changed",
    }));
    expect(rejected).toMatchObject({ status: "rejected", version: 2, retainedEventRef: "event-ref-01" });
    expect(rejected.eventRef).toBeUndefined();
  });

  it("keeps a detached executing proposal from moving back to a non-terminal state", async () => {
    const { database } = await createDatabase();
    await seedExecuting(database);
    await database.write((db) => db.prepare("DELETE FROM calendar_event_refs WHERE event_ref = 'event-ref-01'").run());

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-detached", expectedVersion: 1, from: ["executing"], to: "executing",
    }))).rejects.toThrow("calendar_proposal_detached");
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-detached", expectedVersion: 1, from: ["executing"], to: "pending",
    }))).rejects.toThrow("calendar_proposal_detached");
    await expect(database.read((db) => repository.getProposal(db, actorId, "proposal-detached")))
      .resolves.toMatchObject({ status: "executing", version: 1, retainedEventRef: "event-ref-01" });
  });

  it("requires a live event reference before an event-bound proposal becomes executable", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.insertProposal(db, proposal({ id: "proposal-unbound-update", operation: "update" }), "idem-unbound-update", "hash-unbound-update");
      repository.insertProposal(db, proposal({ id: "proposal-unbound-create", operation: "create" }), "idem-unbound-create", "hash-unbound-create");
    });

    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-unbound-update", expectedVersion: 1, from: ["pending"], to: "executing",
    }))).rejects.toThrow("calendar_event_reference_not_found");
    await expect(database.transaction((db) => repository.transitionProposal(db, {
      actorId, proposalId: "proposal-unbound-create", expectedVersion: 1, from: ["pending"], to: "executing",
    }))).resolves.toMatchObject({ status: "executing", version: 2 });
  });
});

describe("proposal event reference index", () => {
  const plan = async (database: ConnectorDatabase, sql: string, parameters: Record<string, string>) =>
    database.write((db) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>(parameters))
      .then((rows) => rows.map(({ detail }) => detail).join("\n"));

  it("serves the detach trigger and the live-proposal purge check from an (actor_id, event_ref) index", async () => {
    const { database } = await createDatabase();
    // The statement the calendar_event_refs_retain_proposals trigger runs per deleted reference.
    await expect(plan(database, "UPDATE calendar_change_proposals SET retained_event_ref = event_ref, event_ref = NULL WHERE actor_id = :actorId AND event_ref = :eventRef", { actorId, eventRef: "event-ref-01" }))
      .resolves.toMatch(/USING (?:COVERING )?INDEX calendar_change_proposals_event_ref_idx \(actor_id=\? AND event_ref=\?\)/u);
    await expect(plan(database, "SELECT 1 FROM calendar_event_refs WHERE last_observed_at < :olderThan AND NOT EXISTS (SELECT 1 FROM calendar_change_proposals AS proposal WHERE proposal.actor_id = calendar_event_refs.actor_id AND proposal.event_ref = calendar_event_refs.event_ref AND proposal.status IN ('pending', 'executing'))", { olderThan: now }))
      .resolves.toMatch(/calendar_change_proposals_event_ref_idx/u);
  });
});

describe("event reference REPLACE hazard", () => {
  // REPLACE deletes the conflicting row without firing the BEFORE DELETE
  // detach trigger (recursive_triggers is off), so the ON DELETE CASCADE from
  // 0200 silently deletes proposals and their idempotency rows.
  const replaceOnEventRefs = /\b(?:(?:INSERT|UPDATE)\s+OR\s+REPLACE(?:\s+INTO)?|REPLACE\s+INTO)\s+calendar_event_refs\b/iu;
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|sql)$/u.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });

  it("never REPLACEs rows in calendar_event_refs from source or migrations", () => {
    const files = sourceFiles(sourceRoot);
    expect(files.some((file) => file.endsWith("calendar-repository.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("0210_calendar_preserve_proposals.sql"))).toBe(true);
    const offenders = files.filter((file) => {
      const text = readFileSync(file, "utf8");
      const code = file.endsWith(".sql") ? text.replace(/--[^\n]*/gu, "") : text;
      return replaceOnEventRefs.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("documents why: REPLACE bypasses the detach trigger and cascades proposals away", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference());
      repository.insertProposal(db, proposal({ eventRef: "event-ref-01" }), "idem-replace", "hash-replace");
    });

    await database.write((db) => repository.upsertEventReference(db, eventReference({ lastObservedAt: later })));
    await expect(count(database, "calendar_change_proposals")).resolves.toBe(1);

    await database.write((db) => db.prepare(
      "INSERT OR REPLACE INTO calendar_event_refs(actor_id, event_ref, calendar_ref, provider_event_id_ciphertext, provider_event_blind_index, last_observed_at) " +
      "VALUES(:actorId, 'event-ref-01', 'calendar-ref-01', 'fixture', 'blind-event-01', :later)",
    ).run({ actorId, later }));
    await expect(count(database, "calendar_change_proposals")).resolves.toBe(0);
  });
});

describe("proposal replay after event cleanup", () => {
  it("replays an existing idempotent proposal after its event reference expires", async () => {
    const { database } = await createDatabase();
    await seedConnection(database);
    await database.transaction((db) => {
      repository.replaceCalendarSelection(db, actorId, 1, [calendar()], authorizationIdOf(db), systemTransition);
      repository.upsertEventReference(db, eventReference({ lastObservedAt: "2026-10-01T00:00:00.000Z" }));
    });
    const savedProposal = proposal({ id: "proposal-replay-cleanup", eventRef: "event-ref-01" });
    await expect(database.transaction((db) => repository.insertProposal(db, savedProposal, "idempotency-replay-cleanup", "request-replay-cleanup")))
      .resolves.toMatchObject({ kind: "inserted" });
    await database.write((db) => repository.purgeStaleEventReferences(db, "2026-10-10T00:00:00.000Z"));

    await expect(database.transaction((db) => repository.insertProposal(db, savedProposal, "idempotency-replay-cleanup", "request-replay-cleanup")))
      .resolves.toMatchObject({ kind: "replayed", proposal: { id: "proposal-replay-cleanup", eventRef: "event-ref-01" } });
  });
});
